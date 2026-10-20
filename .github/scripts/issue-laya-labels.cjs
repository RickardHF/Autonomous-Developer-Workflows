const { createHash } = require("node:crypto");

const MODEL = {
  repo: "convaiinnovations/laya", subfolder: "multilingual",
  revision: "7b928d828b7b0e022f929d9bd2e44165aa270148", runtime: "0.4.12", max_len: 8192,
};
const CATEGORIES = {
  prompt_injection: [
    ["laya:prompt-injection", "b60205", "Laya: issue contains a prompt-injection attempt; advisory assessment."],
    ["laya:prompt-clean", "0e8a16", "Laya: no prompt-injection attempt detected; not a safety guarantee."],
    ["laya:prompt-ambiguous", "fbca04", "Laya: prompt-injection assessment is uncertain or input exceeds context."],
  ],
  well_defined: [
    ["laya:well-defined", "0e8a16", "Laya: request has sufficient scope, context, and expected outcomes."],
    ["laya:needs-information", "d93f0b", "Laya: request lacks essential scope, context, or expected outcomes."],
    ["laya:definition-ambiguous", "fbca04", "Laya: definition quality is uncertain or input exceeds context."],
  ],
  unsafe_changes: [
    ["laya:requests-errors-or-vulnerabilities", "b60205", "Laya: explicitly requests bugs or vulnerabilities, including educational examples."],
    ["laya:no-error-or-vulnerability-request", "0e8a16", "Laya: no explicit request to introduce bugs or vulnerabilities detected."],
    ["laya:change-intent-ambiguous", "fbca04", "Laya: intent to introduce errors/vulnerabilities is uncertain or input exceeds context."],
  ],
};
const IDENTITY = ["version", "repository", "issue_number", "issue_id", "run_id", "run_attempt", "source_sha", "content_sha"];
const DEFINITIONS = Object.values(CATEGORIES).flat();
const MANAGED = new Set(DEFINITIONS.map(([name]) => name));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function exact(value, fields, name) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  check(Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)),
    `${name} has missing or unexpected fields`);
}

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function contentSha(title, body) {
  check(typeof title === "string" && typeof body === "string", "Invalid issue text");
  return hash(`${hash(title)}:${hash(body)}`);
}

function identity(value, expected) {
  check(value.version === 1, "Unsupported decision version");
  check(value.repository === expected.repository && /^[^/\s]+\/[^/\s]+$/.test(value.repository), "Repository mismatch");
  check(Number.isSafeInteger(value.issue_number) && value.issue_number > 0 &&
    value.issue_number === expected.issueNumber, "Issue number mismatch");
  check(Number.isSafeInteger(value.issue_id) && value.issue_id > 0, "Invalid issue database ID");
  for (const [field, parameter] of [["run_id", "runId"], ["run_attempt", "runAttempt"]]) {
    check(typeof value[field] === "string" && /^[1-9]\d*$/.test(value[field]) &&
      value[field] === String(expected[parameter]), `${field} mismatch`);
  }
  check(/^[a-f0-9]{40}$/.test(value.source_sha) && value.source_sha === expected.sourceSha, "Source revision mismatch");
  check(typeof value.content_sha === "string" && /^[a-f0-9]{64}$/.test(value.content_sha), "Invalid content digest");
}

function target(input) {
  const { event, repository, issueNumber } = input;
  check(typeof repository === "string" && /^[^/\s]+\/[^/\s]+$/.test(repository), "Invalid target repository");
  check(Number.isSafeInteger(issueNumber) && issueNumber > 0, "Invalid target issue number");
  check(["opened", "edited", "reopened"].includes(event?.action), "Unexpected issue event");
  check(!event.issue?.pull_request && event.issue?.number === issueNumber, "Expected an issue, not a PR");
  check(Number.isSafeInteger(event.issue.id) && event.issue.id > 0, "Invalid event issue identity");
  check(event.repository?.full_name === repository, "Event repository mismatch");
  const [owner, repo] = repository.split("/");
  return { owner, repo, issue_number: issueNumber };
}

function liveIssue(issue, input) {
  check(!issue.pull_request && issue.number === input.issueNumber &&
    issue.id === input.event.issue.id, "Live issue identity mismatch");
  check(typeof issue.title === "string" && (issue.body === null || typeof issue.body === "string"), "Invalid live issue content");
}

async function collectSnapshot(input) {
  const parameters = target(input);
  const { data: issue } = await input.github.rest.issues.get(parameters);
  liveIssue(issue, input);
  const snapshot = {
    version: 1, repository: input.repository, issue_number: issue.number, issue_id: issue.id,
    run_id: String(input.runId), run_attempt: String(input.runAttempt), source_sha: input.sourceSha,
    content_sha: contentSha(issue.title, issue.body ?? ""), title: issue.title, body: issue.body ?? "",
  };
  identity(snapshot, input);
  return snapshot;
}

function labelsFor(decision, expected) {
  exact(decision, [...IDENTITY, "model", "status", "scores", "context"], "Decision");
  identity(decision, expected);
  check(decision.issue_id === expected.event.issue.id, "Event issue ID mismatch");
  exact(decision.model, Object.keys(MODEL), "Model");
  check(Object.entries(MODEL).every(([key, value]) => decision.model[key] === value), "Unapproved model configuration");
  exact(decision.scores, Object.keys(CATEGORIES), "Scores");
  exact(decision.context, ["state_tokens", "budget", "truncated"], "Context");
  const { state_tokens: tokens, budget, truncated } = decision.context;
  check(Number.isSafeInteger(tokens) && tokens >= 0 && Number.isSafeInteger(budget) && budget > 0 &&
    budget < MODEL.max_len && typeof truncated === "boolean", "Invalid context accounting");
  check(["complete", "overflow"].includes(decision.status), "Invalid assessment status");
  if (decision.status === "overflow") {
    check(truncated && Object.values(decision.scores).every((score) => score === null), "Invalid overflow result");
    return Object.values(CATEGORIES).map((labels) => labels[2][0]);
  }
  check(!truncated && tokens <= budget, "Incomplete input cannot receive confident labels");
  return Object.entries(CATEGORIES).map(([key, labels]) => {
    const score = decision.scores[key];
    check(typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1, `Invalid ${key} probability`);
    return labels[score >= 0.80 ? 0 : score <= 0.20 ? 1 : 2][0];
  });
}

async function reconcile(input) {
  const parameters = target(input);
  const desired = labelsFor(input.decision, input);
  const read = async () => {
    const { data: issue } = await input.github.rest.issues.get(parameters);
    liveIssue(issue, input);
    check(issue.id === input.decision.issue_id, "Decision issue ID mismatch");
    return issue;
  };
  const fresh = (issue) => contentSha(issue.title, issue.body ?? "") === input.decision.content_sha;
  let issue = await read();
  if (!fresh(issue)) return { status: "stale", labels: [], reason: "Issue content changed; labels were not updated." };
  const { owner, repo } = parameters;
  const existing = await input.github.paginate(input.github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
  for (const [name, color, description] of DEFINITIONS) {
    if (existing.some((label) => label.name === name)) continue;
    try {
      await input.github.rest.issues.createLabel({ owner, repo, name, color, description });
    } catch (error) {
      // Another issue's run may have created the same repository label.
      if (error.status !== 422 || !error.response?.data?.errors?.some((item) =>
        item.resource === "Label" && item.code === "already_exists" && item.field === "name")) throw error;
    }
  }
  issue = await read();
  if (!fresh(issue)) return { status: "stale", labels: [], reason: "Issue changed before reconciliation; issue labels were not updated." };
  const current = issue.labels.map((label) => typeof label === "string" ? label : label.name);
  const additions = desired.filter((label) => !current.includes(label));
  const removals = current.filter((label) => MANAGED.has(label) && !desired.includes(label));
  if (additions.length) await input.github.rest.issues.addLabels({ ...parameters, labels: additions });
  for (const name of removals) {
    try {
      await input.github.rest.issues.removeLabel({ ...parameters, name });
    } catch (error) {
      if (error.status !== 404) throw error;
      // Only tolerate a concurrent label removal, not an inaccessible/deleted issue.
      const latest = await read();
      check(!latest.labels.some((label) => (typeof label === "string" ? label : label.name) === name),
        `Could not remove managed label ${name}`);
    }
  }
  issue = await read();
  if (!fresh(issue)) return {
    status: "stale", labels: desired,
    reason: "Issue changed during reconciliation; applied labels may be stale. A fresh assessment is required.",
  };
  const actual = issue.labels.map((label) => typeof label === "string" ? label : label.name)
    .filter((label) => MANAGED.has(label)).sort();
  check(JSON.stringify(actual) === JSON.stringify([...desired].sort()),
    "Managed labels changed concurrently or were not applied completely; rerun the assessment");
  return {
    status: additions.length || removals.length ? "applied" : "unchanged",
    labels: desired,
    reason: input.decision.status === "overflow" ? "Complete input exceeded context; all categories are ambiguous." :
      "Applied independent 0.20/0.80 probability thresholds; labels are advisory.",
  };
}

module.exports = { MODEL, CATEGORIES, contentSha, collectSnapshot, labelsFor, reconcile };
