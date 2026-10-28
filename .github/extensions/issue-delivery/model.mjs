export const SNAPSHOT_VERSION = 1;
export const RUN_STATUSES = ["pending", "running", "completed", "error", "halted", "paused", "cancelled"];
export const LIVE_STATUSES = new Set(["pending", "running"]);
export const MAX_PROGRESS = 200;
export const STALE_AFTER_MS = 30_000;
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const isRunId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

const contracts = {
  "context.json": ["Run context", { runId: "string", repository: "object", checkout: "string", branch: "string", baseSha: "string", artifacts: "string", issueRequirementDigest: "string" }],
  "issue.json": ["Captured issue", { number: "number", title: "string", body: "nullable-string", url: "string", updatedAt: "string", comments: "array" }],
  "plan.json": ["Implementation plan", { status: "string", goal: "string", scope: "object", acceptanceCriteria: "array", steps: "array", mitigations: "array", rollback: "string", validationRequired: "boolean", blockers: "array" }],
  "implementation.json": ["Implementation", { available: "boolean", output: "nullable-object", changedFiles: "array" }],
  "issue-review.json": ["Issue coverage review", { available: "boolean", output: "nullable-object" }],
  "quality-security-review.json": ["Quality / security review", { available: "boolean", output: "nullable-object" }],
  "decision-gate.json": ["Decision gate", { maximumRecommendation: "string", failures: "array", uncertainties: "array" }],
  "summary.json": ["Synthesis", { recommendation: "string", summary: "string", rationale: "array", findings: "array", remainingRisks: "array", nextSteps: "array" }],
  "review-snapshot.json": ["Reviewed checkout", { branch: "string", head: "string", fingerprint: "string", changedFiles: "array", note: "string" }],
};
const implementation = { status: "string", summary: "string", changes: "array", checks: "array", deviations: "array", blockers: "array" };
const review = { verdict: "string", summary: "string", coverage: "array", findings: "array", checks: "array", criteria: "array" };
const matches = (value, type) => type.startsWith("nullable-")
  ? value === null || matches(value, type.slice(9))
  : type === "array" ? Array.isArray(value) : type === "object" ? isObject(value) : typeof value === type;
const check = (value, fields, prefix = "") => !isObject(value)
  ? [`${prefix || "Value"} must be an object.`]
  : Object.entries(fields).filter(([key, type]) => !matches(value[key], type)).map(([key, type]) => `${prefix}${key}: expected ${type}.`);

export function describeArtifact(name, value) {
  let title = name;
  let warnings = [];
  if (contracts[name]) {
    const [label, fields] = contracts[name];
    title = label;
    warnings = check(value, fields);
    if (isObject(value) && Object.hasOwn(fields, "available")) {
      if (value.available === false) warnings.push("Agent output is unavailable; this is not a passing result.");
      if (value.available === true && value.output === null) warnings.push("Artifact says available but output is null.");
      if (value.output !== null) warnings.push(...check(value.output, name === "implementation.json" ? implementation : review, "output."));
    }
  } else if (name === "result.json") {
    title = "Delivery result";
    warnings = check(value, isObject(value) && value.stage === "plan"
      ? { recommendation: "string", stage: "string", blockers: "array", artifacts: "string" }
      : { recommendation: "string", issueUrl: "string", branch: "string", baseSha: "string", reviewedFingerprint: "string", changedFiles: "array", artifacts: "string", gate: "object", synthesis: "object", reviewAvailability: "object" });
  } else if (name === "untracked-files.json") {
    title = "New-file manifest";
    warnings = Array.isArray(value)
      ? value.slice(0, 100).flatMap((entry, index) => check(entry, { path: "string", mode: "number", sha256: "string", symlink: "boolean" }, `[${index}].`))
      : ["Manifest must be an array."];
    if (Array.isArray(value) && value.length > 100) warnings.push("Preview validation is limited to 100 manifest entries; Raw retains the full manifest.");
  } else if (name === "dashboard.json") {
    title = "Recorded runtime observations";
    if (!validObservation(value)) warnings.push("Unsupported or invalid observation snapshot. Runtime status is unknown.");
  } else {
    warnings.push("No artifact-specific contract. Showing a generic view; all fields remain available in Raw.");
  }
  return { title, warnings };
}

export function validObservation(value) {
  return isObject(value) && value.schemaVersion === SNAPSHOT_VERSION && isRunId(value.runId) &&
    value.workflowName === "issue-delivery" && typeof value.ownerSessionId === "string" &&
    RUN_STATUSES.includes(value.status) && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    (value.currentPhaseId === undefined || value.currentPhaseId === null || typeof value.currentPhaseId === "string") &&
    ["createdAt", "updatedAt", "observedAt"].every((key) => Number.isFinite(value[key])) &&
    Array.isArray(value.phases) && value.phases.every((phase) => isObject(phase) && typeof phase.id === "string" &&
      typeof phase.title === "string" && ["pending", "active", "completed", "skipped"].includes(phase.status)) &&
    Array.isArray(value.agents) && value.agents.every((agent) => isObject(agent) && typeof agent.agentId === "string" &&
      typeof agent.label === "string" && typeof agent.status === "string") &&
    isObject(value.progress) && typeof value.progress.truncated === "boolean" && Array.isArray(value.progress.records) &&
    value.progress.records.every((record) => isObject(record) && typeof record.text === "string" && Number.isFinite(record.seq));
}

export function observationFromDetail(detail, ownerSessionId, now = Date.now()) {
  const timestamp = (value) => Number.isFinite(value) ? value : null;
  const clip = (value) => typeof value === "string" ? value.slice(0, 4_000) : value;
  const records = detail.progress.records.slice(-MAX_PROGRESS).map((record) => ({
    seq: record.seq, attempt: record.attempt, phaseId: record.phaseId,
    recordedAt: record.recordedAt, kind: record.kind, text: clip(record.text),
  }));
  const value = {
    schemaVersion: SNAPSHOT_VERSION, workflowName: detail.workflowName,
    runId: detail.runId, ownerSessionId, revision: detail.revision, status: detail.status,
    createdAt: detail.createdAt, startedAt: timestamp(detail.startedAt),
    updatedAt: detail.updatedAt, completedAt: timestamp(detail.completedAt), observedAt: now,
    currentPhaseId: detail.currentPhase?.id ?? null,
    error: clip(detail.terminal?.error ?? detail.terminal?.reason ?? detail.terminal?.failure?.reason ??
      (detail.terminal?.failure ? JSON.stringify(detail.terminal.failure) : null)),
    phases: detail.phases.map((phase) => ({
      id: phase.id, title: phase.title, status: phase.status,
      startedAt: timestamp(phase.startedAt), completedAt: timestamp(phase.completedAt),
      entryCount: phase.entryCount, lastEnteredRunAttempt: phase.lastEnteredRunAttempt,
    })),
    agents: detail.agents.map((agent) => ({
      agentId: agent.agentId, phaseId: agent.phaseId, label: clip(agent.label), status: agent.status,
      startedAt: timestamp(agent.startedAt), completedAt: timestamp(agent.completedAt),
    })),
    progress: {
      records,
      truncated: Boolean(detail.progress.hasMoreOlder || detail.progress.hasMoreNewer ||
        detail.progress.records.length > MAX_PROGRESS || detail.progress.records.some((record) => record.text.length > 4_000)),
    },
  };
  if (!validObservation(value)) throw new Error("Runtime returned an unsupported issue-delivery observation shape.");
  return value;
}

export function freshness(observation, now = Date.now()) {
  if (!observation) return "artifact-only";
  return LIVE_STATUSES.has(observation.status) && now - observation.observedAt > STALE_AFTER_MS ? "stale" : "recorded";
}
