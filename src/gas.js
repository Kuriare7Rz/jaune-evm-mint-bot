const { ethers } = require("ethers");

function gwei(value) {
  return ethers.parseUnits(String(value), "gwei");
}

function clampWei(value, min, max = null) {
  let out = value < min ? min : value;
  if (max !== null && out > max) out = max;
  return out;
}

async function getBaseFee(provider) {
  const block = await provider.getBlock("pending");
  if (block && block.baseFeePerGas) return block.baseFeePerGas;
  const fee = await provider.getFeeData();
  return fee.lastBaseFeePerGas || fee.gasPrice || gwei(30);
}

async function getPriorityFee(provider, config) {
  const min = gwei(config.minPriorityGwei);
  const max = gwei(config.maxPriorityGwei);
  try {
    const rpcValue = BigInt(
      await provider.send("eth_maxPriorityFeePerGas", []),
    );
    return clampWei(rpcValue, min, max);
  } catch {
    const fee = await provider.getFeeData();
    return clampWei(fee.maxPriorityFeePerGas || min, min, max);
  }
}

async function buildFeePlan(provider, config) {
  const [baseFee, maxPriorityFeePerGas] = await Promise.all([
    getBaseFee(provider),
    getPriorityFee(provider, config),
  ]);
  let maxFeePerGas =
    (baseFee * config.baseFeeMultiplier) / 100n + maxPriorityFeePerGas;
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  return { baseFee, maxFeePerGas, maxPriorityFeePerGas };
}

async function estimateGas(provider, tx, fallbackGasLimit) {
  try {
    return await provider.estimateGas(tx);
  } catch {
    return fallbackGasLimit;
  }
}

module.exports = { buildFeePlan, estimateGas, gwei };
