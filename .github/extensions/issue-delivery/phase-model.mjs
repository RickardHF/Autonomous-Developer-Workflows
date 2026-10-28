const outputs = {
  Prepare: ["issue.json", "context.json"],
  Plan: ["plan.json"],
  Implement: ["implementation.json", "changes.patch", "review-snapshot.json"],
  Review: ["issue-review.json", "quality-security-review.json"],
  Summarize: ["report.md", "result.json", "summary.json", "decision-gate.json"],
};
const labels = {
  "issue.json": "Captured issue", "context.json": "Run context", "plan.json": "Implementation plan",
  "implementation.json": "Implementation result", "changes.patch": "Source changes",
  "untracked-files.json": "New-file manifest", "review-snapshot.json": "Reviewed checkout",
  "issue-review.json": "Issue coverage", "quality-security-review.json": "Quality & security",
  "report.md": "Delivery report", "result.json": "Final result", "summary.json": "Review synthesis",
  "decision-gate.json": "Decision gate", "dashboard.json": "Runtime observations",
};
const states = {
  completed: ["Completed", "green"], pending: ["Not started", "gray"], skipped: ["Skipped", "gray"],
  error: ["Error", "red"], active: ["In progress", "blue"], closed: ["Closed unfinished", "yellow"],
  unknown: ["Unknown", "gray"],
};
const stopped = new Set(["halted", "paused", "cancelled"]);
const failed = new Set(["error", "failed"]);
const key = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function latestAgents(agents) {
  const latest = new Map();
  for (const agent of agents) {
    const previous = latest.get(agent.label);
    if (!previous || (agent.startedAt ?? 0) >= (previous.startedAt ?? 0)) latest.set(agent.label, agent);
  }
  return [...latest.values()];
}

function phaseState(observed, observation, freshness, currentId, agents, evidence) {
  if (!observed) return ["unknown", "Runtime history was not recorded for this phase."];
  if (observed.status === "pending") return ["pending", "This phase has not started."];
  if (observed.status === "skipped") return ["skipped", "The runtime skipped this phase."];
  if (observation.status === "error" && observed.id === currentId) return ["error", observation.error || "Execution stopped with an error in this phase."];
  if (agents.some((agent) => failed.has(agent.status))) return ["error", "An agent in this phase failed."];
  if (agents.some((agent) => stopped.has(agent.status))) return ["closed", "An agent stopped before this phase finished."];
  if (observed.status === "active" && stopped.has(observation.status)) {
    return ["closed", `The run was ${observation.status} before this phase finished.`];
  }
  if (observed.status === "active") {
    if (observation.status === "completed") return ["closed", "The run closed while this phase remained unfinished."];
    if (freshness === "stale") return ["unknown", "Last observed in progress. Live status is unavailable because recording is stale."];
    return ["active", "This phase is currently in progress."];
  }
  // Persisted outputs can belong to a prior attempt while a resumed phase is active.
  if (evidence.some((value) => Array.isArray(value?.checks) && value.checks.some((check) => check?.outcome === "failed") || value?.verdict === "fail")) {
    return ["error", "This phase recorded a failed check or review verdict."];
  }
  if (evidence.some((value) => value?.status === "blocked" || value?.available === false ||
      value?.available === true && (value.output === null || typeof value.output !== "object" || Array.isArray(value.output)))) {
    return ["closed", "The phase closed without a complete output."];
  }
  return ["completed", "The phase completed. This is separate from the final delivery recommendation."];
}

export function buildPhaseModel(run, definitions, metadata = {}) {
  const observation = run.observation;
  const entered = observation?.phases.filter((phase) => ["active", "completed"].includes(phase.status)) ?? [];
  const currentId = observation?.currentPhaseId ?? entered.find((phase) => phase.status === "active")?.id ?? entered.at(-1)?.id;
  const namesFor = (title) => {
    const names = outputs[title] ?? [];
    if (metadata["result.json"]?.stage !== "plan") return names;
    return title === "Plan" ? [...names, "result.json"] : names.filter((name) => name !== "result.json");
  };
  const assigned = new Set(definitions.flatMap((definition) => namesFor(definition.title)));
  const files = new Map(run.artifacts.map((artifact) => [artifact.name, artifact]));
  const artifact = (entry) => ({ ...entry, label: labels[entry.name] ?? entry.name, format: entry.name.endsWith(".json") ? "JSON" : entry.name.endsWith(".md") ? "Markdown" : entry.name.endsWith(".patch") ? "Patch" : "Text" });
  const phases = definitions.map((definition, index) => {
    const observed = observation?.phases.find((phase) => phase.title === definition.title);
    const agents = latestAgents((observation?.agents ?? []).filter((agent) => observed && agent.phaseId === observed.id));
    const names = namesFor(definition.title);
    const evidence = names.flatMap((name) => {
      const value = metadata[name];
      return value ? [value, value.output] : [];
    });
    const [state, reason] = phaseState(observed, observation, run.freshness, currentId, agents, evidence);
    const [status, color] = states[state];
    return {
      key: key(definition.title), title: definition.title, detail: definition.detail,
      dependsOn: index ? [key(definitions[index - 1].title)] : [],
      runtimeId: observed?.id ?? null, state, status, color, reason, agents,
      ...(definition.title === "Implement" && files.has("review-snapshot.json") ? { checkout: artifact(files.get("review-snapshot.json")) } : {}),
      artifacts: names.filter((name) => name !== "review-snapshot.json" && files.has(name)).map((name) => artifact(files.get(name))),
    };
  });
  return { phases, runArtifacts: run.artifacts.filter((entry) => !assigned.has(entry.name)).map(artifact) };
}
