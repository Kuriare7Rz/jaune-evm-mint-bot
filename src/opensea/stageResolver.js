const STAGES_QUERY = `query DropBySlug($slug: String!) {
  dropBySlug(slug: $slug) {
    stages { stageIndex stageType startTime endTime name price { unit } }
  }
}`;

async function fetchOpenSeaStages(config, logger) {
  if (!config.openSeaCollectionSlug) return [];
  const headers = {
    "content-type": "application/json",
    "x-app-id": "opensea-web",
    "user-agent": "Mozilla/5.0 jaune-evm-mint-bot",
  };

  try {
    const response = await fetch("https://gql.opensea.io/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "DropBySlug",
        query: STAGES_QUERY,
        variables: { slug: config.openSeaCollectionSlug },
      }),
    });
    if (!response.ok) return [];
    const json = await response.json();
    return json?.data?.dropBySlug?.stages || [];
  } catch (error) {
    logger.warn("OpenSea stage lookup failed", { error: error.message });
    return [];
  }
}

function classifyStage(stage) {
  const label = `${stage?.name || ""} ${stage?.stageType || ""}`.toLowerCase();
  if (/fcfs|first.come/.test(label)) return "FCFS_PROOF_REQUIRED_OR_RAW";
  if (/allow|white|presale|early|premint/.test(label))
    return "ALLOWLIST_PROOF_REQUIRED";
  if (/public|open/.test(label)) return "PUBLIC_MINT";
  return "UNKNOWN_STAGE";
}

function activeStage(stages, now = Date.now()) {
  for (const stage of stages) {
    const start = stage.startTime ? Date.parse(stage.startTime) : 0;
    const end = stage.endTime ? Date.parse(stage.endTime) : Infinity;
    if (now >= start && now <= end)
      return { ...stage, selectedMode: classifyStage(stage), status: "active" };
  }
  const next = stages
    .map((stage) => ({
      ...stage,
      startMs: stage.startTime ? Date.parse(stage.startTime) : Infinity,
    }))
    .filter((stage) => Number.isFinite(stage.startMs) && stage.startMs > now)
    .sort((a, b) => a.startMs - b.startMs)[0];
  return next
    ? { ...next, selectedMode: classifyStage(next), status: "wait" }
    : null;
}

async function resolveStage(config, logger) {
  const stages = await fetchOpenSeaStages(config, logger);
  const selected = activeStage(stages);
  if (selected) {
    logger.info("OpenSea stage resolved", {
      name: selected.name,
      type: selected.stageType,
      selectedMode: selected.selectedMode,
      status: selected.status,
      startTime: selected.startTime,
      endTime: selected.endTime,
    });
  }
  return { stages, selected };
}

module.exports = {
  fetchOpenSeaStages,
  activeStage,
  classifyStage,
  resolveStage,
};
