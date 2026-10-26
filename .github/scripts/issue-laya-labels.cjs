const { createHash } = require("node:crypto");

const MODEL = {
  repo: "convaiinnovations/laya", subfolder: "multilingual",
  revision: "7b928d828b7b0e022f929d9bd2e44165aa270148", runtime: "0.4.12", max_len: 8192,
};
const CATEGORIES = {
  malicious_prompt_injection: [
    ["laya:malicious-prompt-injection", "b60205", "Laya: malicious attempt to control the evaluating AI; advisory assessment."],
    ["laya:prompt-clean", "0e8a16", "Laya: no malicious evaluator manipulation detected; not a safety guarantee."],
    ["laya:prompt-ambiguous", "fbca04", "Laya: malicious-injection assessment is uncertain or input exceeds context."],
  ],
  issue_state: [
    ["laya:well-defined", "0e8a16", "Laya: request has sufficient scope, context, and expected outcomes."],
    ["laya:needs-refinement", "d93f0b", "Laya: concrete request needs material scope, behavior, or acceptance decisions."],
    ["laya:needs-details", "d93f0b", "Laya: insufficient substantive information to identify or investigate the request."],
    ["laya:state-ambiguous", "fbca04", "Laya: issue state is uncertain or input exceeds context."],
  ],
  unsafe_changes: [
    ["laya:requests-errors-or-vulnerabilities", "b60205", "Laya: explicitly requests bugs or vulnerabilities, including educational examples."],
    ["laya:no-error-or-vulnerability-request", "0e8a16", "Laya: no explicit request to introduce bugs or vulnerabilities detected."],
    ["laya:change-intent-ambiguous", "fbca04", "Laya: intent to introduce errors/vulnerabilities is uncertain or input exceeds context."],
  ],
};
const IDENTITY = ["version", "repository", "issue_number", "issue_id", "run_id", "run_attempt", "source_sha", "content_sha"];
const STATES = ["ready", "decisions", "information"];
const PRECHECKS = ["empty", "template_only", "placeholder"];
const LEGACY = ["laya:prompt-injection", "laya:needs-information", "laya:definition-ambiguous"];
const POLICY = { version: 2, injection: { positive: 0.90, negative: 0.10 }, state: 0.85, unsafe: { positive: 0.80, negative: 0.20 } };
const DEFINITIONS = Object.values(CATEGORIES).flat();
const MANAGED = new Set([...DEFINITIONS.map(([name]) => name), ...LEGACY]);

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
  check(value.version === POLICY.version, "Unsupported decision version");
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

function runConfiguration({ event, eventName, ref, dryRunVariable = "" }) {
  check(["", "true", "false"].includes(dryRunVariable), "LAYA_DRY_RUN must be true, false, or unset");
  check(["issues", "workflow_dispatch"].includes(eventName), "Unexpected workflow event");
  if (eventName === "issues") {
    return { operation: "assess", issueNumber: event.issue?.number, dryRun: dryRunVariable === "true" };
  }
  check(typeof event.repository?.default_branch === "string" && event.repository.default_branch.length > 0 &&
    ref === `refs/heads/${event.repository.default_branch}`, "Manual runs require the trusted default branch");
  const { operation, issue_number: number, dry_run: dryRun } = event.inputs ?? {};
  check(["assess", "warm-cache"].includes(operation), "Invalid manual operation");
  check(["true", "false"].includes(dryRun), "Manual dry_run must be true or false");
  if (operation === "warm-cache") {
    check(!number, "Cache warming does not accept an issue number");
    return { operation, issueNumber: null, dryRun: true };
  }
  check(typeof number === "string" && /^[1-9]\d*$/.test(number) && Number.isSafeInteger(Number(number)),
    "Manual assessment requires a positive issue number");
  return { operation, issueNumber: Number(number), dryRun: dryRunVariable === "true" || dryRun === "true" };
}

function target(input) {
  const { event, repository, issueNumber } = input;
  check(typeof repository === "string" && /^[^/\s]+\/[^/\s]+$/.test(repository), "Invalid target repository");
  check(Number.isSafeInteger(issueNumber) && issueNumber > 0, "Invalid target issue number");
  const configuration = runConfiguration(input);
  check(configuration.operation === "assess" && configuration.issueNumber === issueNumber, "Unexpected assessment target");
  if (input.eventName === "issues") {
    check(["opened", "edited", "reopened"].includes(event?.action), "Unexpected issue event");
    check(!event.issue?.pull_request && event.issue?.number === issueNumber, "Expected an issue, not a PR");
    check(Number.isSafeInteger(event.issue.id) && event.issue.id > 0, "Invalid event issue identity");
  }
  check(event.repository?.full_name === repository, "Event repository mismatch");
  const [owner, repo] = repository.split("/");
  return { owner, repo, issue_number: issueNumber };
}

function liveIssue(issue, input) {
  check(!issue.pull_request && issue.number === input.issueNumber &&
    Number.isSafeInteger(issue.id) && issue.id > 0 &&
    (input.eventName === "workflow_dispatch" || issue.id === input.event.issue.id), "Live issue identity mismatch");
  check(typeof issue.title === "string" && (issue.body === null || typeof issue.body === "string"), "Invalid live issue content");
}

async function collectSnapshot(input) {
  const parameters = target(input);
  const { data: issue } = await input.github.rest.issues.get(parameters);
  liveIssue(issue, input);
  const snapshot = {
    version: POLICY.version, repository: input.repository, issue_number: issue.number, issue_id: issue.id,
    run_id: String(input.runId), run_attempt: String(input.runAttempt), source_sha: input.sourceSha,
    content_sha: contentSha(issue.title, issue.body ?? ""), title: issue.title, body: issue.body ?? "",
  };
  identity(snapshot, input);
  return snapshot;
}

function labelsFor(decision, expected) {
  target(expected);
  exact(decision, [...IDENTITY, "model", "status", "scores", "state_precheck", "context"], "Decision");
  identity(decision, expected);
  if (expected.eventName === "issues") check(decision.issue_id === expected.event.issue.id, "Event issue ID mismatch");
  exact(decision.model, Object.keys(MODEL), "Model");
  check(Object.entries(MODEL).every(([key, value]) => decision.model[key] === value), "Unapproved model configuration");
  exact(decision.scores, Object.keys(CATEGORIES), "Scores");
  exact(decision.context, ["state_tokens", "budget", "truncated"], "Context");
  const { state_tokens: tokens, budget, truncated } = decision.context;
  check(Number.isSafeInteger(tokens) && tokens >= 0 && Number.isSafeInteger(budget) && budget > 0 &&
    budget < MODEL.max_len && typeof truncated === "boolean", "Invalid context accounting");
  check(["complete", "overflow"].includes(decision.status), "Invalid assessment status");
  if (decision.status === "overflow") {
    check(truncated && decision.state_precheck === null &&
      Object.values(decision.scores).every((score) => score === null), "Invalid overflow result");
    return Object.values(CATEGORIES).map((labels) => labels.at(-1)[0]);
  }
  check(!truncated && tokens <= budget, "Incomplete input cannot receive confident labels");
  const probability = (score) => check(typeof score === "number" && Number.isFinite(score) &&
    score >= 0 && score <= 1, "Invalid probability");
  const binaryLabel = (key, thresholds) => {
    const value = decision.scores[key];
    probability(value);
    return CATEGORIES[key][value >= thresholds.positive ? 0 : value <= thresholds.negative ? 1 : 2][0];
  };
  const precheck = decision.state_precheck;
  const state = decision.scores.issue_state;
  let stateLabel;
  if (precheck !== null) {
    check(PRECHECKS.includes(precheck) && state === null, "Invalid deterministic state precheck");
    stateLabel = CATEGORIES.issue_state[2][0];
  } else {
    exact(state, ["choice", "probabilities"], "Issue state");
    exact(state.probabilities, STATES, "State probabilities");
    Object.values(state.probabilities).forEach(probability);
    check(STATES.includes(state.choice) &&
      Math.abs(Object.values(state.probabilities).reduce((sum, value) => sum + value, 0) - 1) <= 0.0002 &&
      state.probabilities[state.choice] === Math.max(...Object.values(state.probabilities)), "Invalid state distribution");
    stateLabel = CATEGORIES.issue_state[state.probabilities[state.choice] >= POLICY.state ? STATES.indexOf(state.choice) : 3][0];
  }
  return [binaryLabel("malicious_prompt_injection", POLICY.injection), stateLabel, binaryLabel("unsafe_changes", POLICY.unsafe)];
}

async function reconcile(input) {
  check(typeof input.dryRun === "boolean", "Explicit dry-run mode required");
  check(input.dryRun || !runConfiguration(input).dryRun, "Dry-run configuration forbids writes");
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
  const changes = (value) => {
    const current = value.labels.map((label) => typeof label === "string" ? label : label.name);
    return {
      additions: desired.filter((label) => !current.includes(label)),
      removals: current.filter((label) => MANAGED.has(label) && !desired.includes(label)),
    };
  };
  if (input.dryRun) return {
    status: "dry-run", labels: desired, ...changes(issue),
    reason: "Validated current content and proposed labels; no repository or issue labels were changed.",
  };
  const { owner, repo } = parameters;
  const existing = await input.github.paginate(input.github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
  for (const [name] of DEFINITIONS) {
    check(!existing.some((label) => label.name !== name && label.name.toLowerCase() === name),
      `Label spelling conflicts with "${name}"; rename it to the exact lowercase name before rerunning Laya`);
  }
  for (const [name, color, description] of DEFINITIONS) {
    const label = existing.find((item) => item.name === name);
    if (label) {
      if (label.color !== color || label.description !== description) {
        await input.github.rest.issues.updateLabel({ owner, repo, name, color, description });
      }
      continue;
    }
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
  const { additions, removals } = changes(issue);
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
    labels: desired, additions, removals,
    reason: input.decision.status === "overflow" ? "Complete input exceeded context; all categories are ambiguous." :
      "Applied policy v2 category-specific confidence gates; labels are advisory.",
  };
}

module.exports = { MODEL, CATEGORIES, POLICY, LEGACY, contentSha, runConfiguration, collectSnapshot, labelsFor, reconcile };
