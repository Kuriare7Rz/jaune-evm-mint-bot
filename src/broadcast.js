const { ethers } = require("ethers");

function isAlreadyKnown(error) {
  const msg = String(error?.shortMessage || error?.message || "");
  return /already known|already imported|known transaction|nonce too low/i.test(
    msg,
  );
}

async function broadcastEverywhere(providers, raw) {
  // Fire the same signed raw tx at every endpoint at once. Same raw bytes =>
  // same hash everywhere; losing endpoints answer "already known", which
  // means the tx landed — that counts as success, not failure.
  const attempts = await Promise.allSettled(
    providers.map((provider) => provider.broadcastTransaction(raw)),
  );

  let response = null;
  let known = false;
  for (const attempt of attempts) {
    if (attempt.status === "fulfilled" && !response) {
      response = attempt.value;
    } else if (attempt.status === "rejected" && isAlreadyKnown(attempt.reason)) {
      known = true;
    }
  }
  return { response, known, endpoints: providers.length };
}

async function sendPublic(wallet, tx, logger) {
  const response = await wallet.sendTransaction(tx);
  logger.info("transaction submitted", {
    hash: response.hash,
    wallet: wallet.address,
    to: tx.to,
  });
  const receipt = await response.wait();
  logger.info("transaction confirmed", {
    hash: response.hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  });
  return { response, receipt };
}

async function broadcastGasLadder(config, wallet, txs, logger, ctx = {}) {
  const providers = ctx.providers?.length ? ctx.providers : [wallet.provider];
  const nonce = ctx.nonce ?? (await wallet.getNonce("pending"));
  const chainId =
    ctx.chainId ?? Number((await wallet.provider.getNetwork()).chainId);

  // Sign the whole ladder locally first — signing never sits between
  // broadcasts when the ladder fires.
  const signed = [];
  for (const item of txs) {
    const tx = { ...item.tx, nonce, chainId, type: 2 };
    const raw = await wallet.signTransaction(tx);
    signed.push({
      raw,
      tierPct: item.tierPct,
      hash: ethers.Transaction.from(raw).hash,
    });
  }

  logger.info("broadcast same-nonce gas ladder", {
    wallet: wallet.address,
    nonce,
    tiers: signed.map((item) => item.tierPct).join(","),
    endpoints: providers.length,
  });

  const results = await Promise.allSettled(
    signed.map(async (item) => {
      const landed = await broadcastEverywhere(providers, item.raw);
      if (!landed.response && !landed.known) {
        throw new Error("tier rejected by all endpoints");
      }
      logger.info("tier submitted", {
        tierPct: item.tierPct,
        hash: item.hash,
        endpoints: landed.endpoints,
      });
      return { tierPct: item.tierPct, hash: item.hash, response: landed.response };
    }),
  );

  const accepted = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  for (const result of results.filter((item) => item.status === "rejected")) {
    logger.warn("tier rejected", {
      error: result.reason.shortMessage || result.reason.message,
    });
  }

  if (!accepted.length) throw new Error("All gas ladder broadcasts failed");

  // Receipt waiting is returned as a handle so the caller can fire every
  // wallet's ladder first and collect confirmations afterwards, in parallel.
  const primary = accepted[0];
  async function waitForReceipt() {
    if (primary.response) return primary.response.wait();
    return providers[0].waitForTransaction(primary.hash);
  }

  return { accepted, hash: primary.hash, tierPct: primary.tierPct, waitForReceipt };
}

module.exports = { broadcastGasLadder, sendPublic, broadcastEverywhere };
