const { ethers } = require("ethers");

async function connectRpc(config, logger) {
  const working = [];
  await Promise.all(
    config.rpcUrls.map(async (url) => {
      const provider = new ethers.JsonRpcProvider(url, undefined, {
        staticNetwork: false,
      });
      const started = Date.now();
      try {
        const [blockNumber, network] = await Promise.all([
          provider.getBlockNumber(),
          provider.getNetwork(),
        ]);
        const latencyMs = Date.now() - started;
        working.push({
          provider,
          url,
          latencyMs,
          blockNumber,
          chainId: Number(network.chainId),
        });
        logger.info("rpc ok", {
          url,
          latencyMs,
          blockNumber,
          chainId: Number(network.chainId),
        });
      } catch (error) {
        logger.warn("rpc failed", {
          url,
          error: error.shortMessage || error.message,
        });
      }
    }),
  );

  working.sort((a, b) => a.latencyMs - b.latencyMs);
  if (!working.length) throw new Error("No working RPC");

  const best = working[0];
  if (best.chainId !== config.expectedChainId) {
    throw new Error(
      `RPC chainId ${best.chainId} does not match ${config.chainIdentifier} (${config.expectedChainId})`,
    );
  }
  // Keep every working endpoint: broadcasts fan out to all of them, reads
  // stay on the fastest one.
  best.providers = working.map((entry) => entry.provider);
  best.urls = working.map((entry) => entry.url);
  return best;
}

async function contractHasCode(provider, address) {
  const code = await provider.getCode(address);
  return code && code !== "0x";
}

module.exports = { connectRpc, contractHasCode };
