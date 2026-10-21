#!/usr/bin/env node
const { ethers } = require("ethers");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const { connectRpc, contractHasCode } = require("./rpc");
const { deriveWallets } = require("./wallet");
const { buildFeePlan, estimateGas } = require("./gas");
const { summarizeMintCost } = require("./mint");
const { broadcastGasLadder } = require("./broadcast");
const { fetchOpenSeaTransaction } = require("./opensea");
const { resolveStage } = require("./opensea/stageResolver");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyGasTier(feePlan, tierPct) {
  const pct = BigInt(tierPct);
  return {
    ...feePlan,
    maxFeePerGas: (feePlan.maxFeePerGas * pct) / 100n,
    maxPriorityFeePerGas: (feePlan.maxPriorityFeePerGas * pct) / 100n,
  };
}

async function waitUntilStart(startAt, logger) {
  if (!startAt) return;
  const target = Date.parse(startAt);
  const left = target - Date.now();
  if (left <= 0) return;
  logger.info("waiting for START_AT", { startAt, waitMs: left });
  await sleep(left);
}

async function preflight(config, provider, wallets, logger) {
  const nftHasCode = await contractHasCode(provider, config.nftContract);
  if (!nftHasCode)
    throw new Error("NFT_CONTRACT has no code on selected chain");

  logger.info("preflight config ok", {
    chainIdentifier: config.chainIdentifier,
    chainId: config.expectedChainId,
    nftContract: config.nftContract,
    quantity: config.quantity,
    dryRun: config.dryRun,
    preflightOnly: config.preflightOnly,
  });

  // Balances are collected here, BEFORE the start gun — the fire path never
  // spends an RPC round-trip on them again.
  const balances = new Map();
  await Promise.all(
    wallets.map(async (wallet) => {
      const balance = await provider.getBalance(wallet.address);
      balances.set(wallet.address, balance);
      logger.info("wallet ok", {
        wallet: wallet.address,
        balanceEth: ethers.formatEther(balance),
      });
    }),
  );
  return balances;
}

async function run() {
  const config = loadConfig();
  const logger = createLogger({ file: config.logFile });
  const rpc = await connectRpc(config, logger);
  const provider = rpc.provider;
  const chainId = rpc.chainId;

  // Broadcast fans out to every working RPC; an optional private relay
  // (e.g. Flashbots Protect) joins the fan-out as a broadcast-only endpoint.
  const broadcastProviders = [...(rpc.providers || [provider])];
  if (config.privateRelayUrl) {
    broadcastProviders.push(new ethers.JsonRpcProvider(config.privateRelayUrl));
    logger.info("private relay enabled for broadcast", {
      endpoints: broadcastProviders.length,
    });
  }

  const wallets = deriveWallets(config.privateKeys, provider);
  await resolveStage(config, logger);

  const balances = await preflight(config, provider, wallets, logger);
  if (config.preflightOnly) return;
  if (!wallets.length) throw new Error("Missing PRIVATE_KEY in .env");

  await waitUntilStart(config.startAt, logger);
  const feePlan = await buildFeePlan(provider, config);

  // PHASE 1 — fetch the raw tx for EVERY wallet in parallel. Each wallet
  // polls OpenSea independently; nobody waits for a sibling's receipt.
  const fetched = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const baseTx = await fetchOpenSeaTransaction(config, wallet, logger);
        return { wallet, baseTx, error: null };
      } catch (error) {
        return { wallet, baseTx: null, error };
      }
    }),
  );
  for (const entry of fetched) {
    if (!entry.baseTx) {
      logger.warn("wallet skipped; no raw tx", {
        wallet: entry.wallet.address,
        error: entry.error?.message || "not released",
      });
    }
  }
  const ready = fetched.filter((entry) => entry.baseTx);
  if (!ready.length) {
    throw new Error(
      "OpenSea raw transaction not released; keep OPENSEA_JWT fresh and try again near phase open",
    );
  }

  // PHASE 2 — estimate gas ONCE. Every wallet's calldata has the same shape;
  // when OpenSea ships a gas buffer multiplier, apply it instead of guessing.
  const sample = ready[0];
  let gasLimit = await estimateGas(
    provider,
    { from: sample.wallet.address, ...sample.baseTx },
    config.gasLimit,
  );
  if (sample.baseTx.bufferMultiplier && sample.baseTx.bufferMultiplier > 1) {
    const scaled =
      (gasLimit * BigInt(Math.round(sample.baseTx.bufferMultiplier * 100))) /
      100n;
    logger.info("opensea gas buffer applied", {
      estimate: gasLimit.toString(),
      multiplier: sample.baseTx.bufferMultiplier,
      gasLimit: scaled.toString(),
    });
    gasLimit = scaled;
  }

  // PHASE 3 — nonces for all wallets in parallel.
  const nonces = await Promise.all(
    ready.map((entry) => entry.wallet.getNonce("pending")),
  );

  // PHASE 4 — build every ladder locally, check cost against the preflight
  // balances (no RPC in this path), then FIRE ALL WALLETS AT ONCE.
  const fired = await Promise.all(
    ready.map(async (entry, i) => {
      const { wallet, baseTx } = entry;
      const cost = summarizeMintCost(baseTx, gasLimit, feePlan);
      const balance = balances.get(wallet.address) ?? 0n;

      logger.info("mint summary", {
        wallet: wallet.address,
        to: baseTx.to,
        quantity: config.quantity,
        valueEth: ethers.formatEther(cost.value),
        gasLimit: gasLimit.toString(),
        maxGasCostEth: ethers.formatEther(cost.maxGasCost),
        maxTotalCostEth: ethers.formatEther(cost.maxTotalCost),
        balanceEth: ethers.formatEther(balance),
      });

      if (balance < cost.maxTotalCost) {
        logger.error("insufficient balance; wallet skipped", {
          wallet: wallet.address,
        });
        return { wallet, handle: null, error: new Error("Insufficient balance") };
      }

      const ladder = config.fireGasTiers.map((tier) => {
        const tierFee = applyGasTier(feePlan, tier);
        return {
          tierPct: tier,
          tx: {
            ...baseTx,
            gasLimit,
            maxFeePerGas: tierFee.maxFeePerGas,
            maxPriorityFeePerGas: tierFee.maxPriorityFeePerGas,
          },
        };
      });

      // The ladder txs must not carry fetcher metadata into the signer.
      for (const rung of ladder) delete rung.tx.bufferMultiplier;

      if (config.dryRun) {
        logger.info("dry-run complete; transaction not broadcast", {
          wallet: wallet.address,
        });
        return { wallet, handle: null, error: null, dryRun: true };
      }

      try {
        const handle = await broadcastGasLadder(config, wallet, ladder, logger, {
          providers: broadcastProviders,
          chainId,
          nonce: nonces[i],
        });
        return { wallet, handle, error: null };
      } catch (error) {
        logger.error("broadcast failed", {
          wallet: wallet.address,
          error: error.message,
        });
        return { wallet, handle: null, error };
      }
    }),
  );

  // PHASE 5 — collect receipts in parallel, after everything is in flight.
  const settled = await Promise.all(
    fired.map(async (entry) => {
      if (!entry.handle) return entry;
      try {
        const receipt = await entry.handle.waitForReceipt();
        logger.info("ladder receipt", {
          wallet: entry.wallet.address,
          hash: entry.handle.hash,
          tierPct: entry.handle.tierPct,
          status: receipt.status,
          blockNumber: receipt.blockNumber,
        });
        return { ...entry, receipt };
      } catch (error) {
        return { ...entry, error };
      }
    }),
  );

  const failed = settled.filter((entry) => entry.error);
  logger.info("mint run complete", {
    wallets: settled.length,
    succeeded: settled.length - failed.length,
    failed: failed.length,
  });
  if (failed.length && failed.length === settled.length) {
    throw new Error("All wallet broadcasts failed");
  }
}

run().catch((error) => {
  console.error(`ERROR ${error.message}`);
  process.exitCode = 1;
});
