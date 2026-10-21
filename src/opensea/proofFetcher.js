const OPENSEA_GQL_URL = "https://gql.opensea.io/graphql";

// Compact but frontend-shaped query: supports TransactionAction and UserOpAction paths.
const MINT_ACTION_TIMELINE_QUERY = `query MintActionTimelineQuery($address: Address!, $fromAssets: [AssetQuantityInput!]!, $toAssets: [AssetQuantityInput!]!, $recipient: Address, $capabilities: WalletCapabilities) {
  swap(address: $address, fromAssets: $fromAssets, toAssets: $toAssets, recipient: $recipient, action: MINT, capabilities: $capabilities) {
    actions {
      __typename
      ... on TransactionAction {
        transactionSubmissionData { to data value chain { networkId identifier gasLimitBufferMultiplier __typename } __typename }
      }
      ... on UserOpAction {
        actionBundleToken
        calls {
          __typename
          ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier __typename } __typename } }
        }
        networkFee { usdPriceEstimate __typename }
      }
      ... on SignatureRequestAction { signatureRequest { message __typename } __typename }
      ... on RefreshAction { message __typename }
    }
    errors { __typename }
  }
}`;

function assetQuantity(config) {
  return {
    item: {
      chain: { identifier: config.chainIdentifier },
      contractAddress: config.nftContract,
      tokenId: null,
    },
    quantity: String(config.quantity),
  };
}

function extractRawTx(payload) {
  const actions = payload?.data?.swap?.actions || [];
  for (const action of actions) {
    const direct = action?.transactionSubmissionData;
    if (direct?.to && direct?.data) return direct;
    for (const call of action?.calls || []) {
      const tx = call?.transactionSubmissionData;
      if (tx?.to && tx?.data) return tx;
    }
  }
  return null;
}

function extractErrors(payload) {
  return (payload?.data?.swap?.errors || [])
    .map((item) => item.__typename)
    .filter(Boolean);
}

async function requestOpenSeaRawTx(config, wallet, logger) {
  if (!config.openSeaJwt) {
    logger.warn("OpenSea raw tx skipped; OPENSEA_JWT missing");
    return { rawTx: null, errors: ["AUTH_MISSING"] };
  }

  const headers = {
    "content-type": "application/json",
    "x-signed-query": "false",
    "x-app-id": "opensea-web",
    "user-agent": "Mozilla/5.0 jaune-evm-mint-bot",
  };
  if (config.openSeaJwt) headers.authorization = `Bearer ${config.openSeaJwt}`;

  const body = {
    operationName: "MintActionTimelineQuery",
    query: MINT_ACTION_TIMELINE_QUERY,
    variables: {
      address: wallet.address,
      fromAssets: [],
      toAssets: [assetQuantity(config)],
      recipient: wallet.address,
      capabilities: { supportsEIP1559: true },
    },
  };

  const response = await fetch(OPENSEA_GQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    logger.warn("OpenSea raw tx fetch failed", { status: response.status });
    return { rawTx: null, errors: [`HTTP_${response.status}`] };
  }

  const json = await response.json();
  const raw = extractRawTx(json);
  const errors = extractErrors(json);
  if (!raw) return { rawTx: null, errors };

  return {
    rawTx: {
      to: raw.to,
      data: raw.data,
      value: BigInt(raw.value || 0),
      route: "opensea-raw",
    },
    errors,
  };
}

async function fetchOpenSeaRawTx(config, wallet, logger) {
  const maxPolls = config.openSeaPolls;
  for (let poll = 1; poll <= maxPolls; poll++) {
    const result = await requestOpenSeaRawTx(config, wallet, logger);
    if (result.rawTx) {
      logger.info("OpenSea raw tx obtained", { poll, to: result.rawTx.to });
      return result.rawTx;
    }
    logger.info("OpenSea raw tx not released yet", {
      poll,
      maxPolls,
      errors: result.errors.join(","),
    });
    if (poll < maxPolls)
      await new Promise((resolve) =>
        setTimeout(resolve, config.openSeaPollIntervalMs),
      );
  }
  return null;
}

module.exports = { fetchOpenSeaRawTx, requestOpenSeaRawTx, extractRawTx };
