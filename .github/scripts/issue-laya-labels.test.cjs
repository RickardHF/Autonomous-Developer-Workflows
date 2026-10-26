const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { test } = require("node:test");
const { MODEL, CATEGORIES, POLICY, LEGACY, contentSha, runConfiguration, collectSnapshot, labelsFor, reconcile } = require("./issue-laya-labels.cjs");

const clone = (value) => structuredClone(value);
const definitions = Object.values(CATEGORIES).flat();
const managed = new Set([...definitions.map(([name]) => name), ...LEGACY]);
const stateScore = (choice = "ready", confidence = 0.9) => ({
  choice, probabilities: Object.fromEntries(["ready", "decisions", "information"]
    .map((key) => [key, key === choice ? confidence : (1 - confidence) / 2])),
});
const fixture = () => {
  const issue = {
    id: 70, number: 7, title: "Fix settings", body: "Restore settings after a null profile.",
    labels: [{ name: "bug" }, { name: "high" }, { name: "copilot:plan-and-implement" }],
  };
  const input = {
    repository: "example/project", issueNumber: 7, runId: "123", runAttempt: "1", sourceSha: "a".repeat(40),
    eventName: "issues", ref: "refs/heads/main", dryRun: false,
    event: { action: "edited", issue: { number: 7, id: 70 }, repository: { full_name: "example/project" } },
    decision: {
      version: 2, repository: "example/project", issue_number: 7, issue_id: 70,
      run_id: "123", run_attempt: "1", source_sha: "a".repeat(40),
      content_sha: contentSha(issue.title, issue.body), model: clone(MODEL), status: "complete",
      scores: { malicious_prompt_injection: 0.1, issue_state: stateScore(), unsafe_changes: 0.5 },
      state_precheck: null,
      context: { state_tokens: 100, budget: 8000, truncated: false },
    },
  };
  const github = {
    issue, definitions: [], calls: [], gets: 0, onGet: () => {}, fail: null,
    async paginate(method, parameters) {
      assert.equal(method, this.rest.issues.listLabelsForRepo);
      assert.equal(parameters.per_page, 100);
      this.calls.push(["list", clone(parameters)]);
      return clone(this.definitions);
    },
    rest: { issues: {} },
    writes() { return this.calls.filter(([method]) => !["get", "list"].includes(method)); },
  };
  for (const method of ["get", "createLabel", "updateLabel", "addLabels", "removeLabel", "listLabelsForRepo"]) {
    github.rest.issues[method] = async (parameters) => {
      github.calls.push([method, clone(parameters)]);
      if (github.fail) await github.fail(method, parameters);
      if (method === "get") {
        github.onGet(++github.gets);
        return { data: clone(github.issue) };
      }
      if (method === "createLabel") github.definitions.push(clone(parameters));
      if (method === "updateLabel") Object.assign(github.definitions.find(({ name }) => name === parameters.name), parameters);
      if (method === "addLabels") {
        for (const name of parameters.labels) {
          if (!github.issue.labels.some((label) => label.name === name)) github.issue.labels.push({ name });
        }
      }
      if (method === "removeLabel") github.issue.labels = github.issue.labels.filter((label) => label.name !== parameters.name);
      return { data: {} };
    };
  }
  input.github = github;
  return { input, github };
};

test("snapshot reads live text and handles null bodies and Unicode consistently with Python", async () => {
  const { input, github } = fixture();
  github.issue.title = 'Unicode: \u00e5 \ud83d\ude00 "quoted"\n';
  github.issue.body = null;
  const snapshot = await collectSnapshot(input);
  assert.equal(snapshot.title, github.issue.title);
  assert.equal(snapshot.body, "");
  assert.equal(snapshot.content_sha, contentSha(github.issue.title, ""));
  assert.equal(snapshot.run_attempt, "1");
  assert.equal(github.writes().length, 0);
  const python = spawnSync(process.env.PYTHON || "python3", ["-c", [
    "import hashlib,json,sys",
    "s=json.load(sys.stdin)",
    "h=lambda v: hashlib.sha256(v.encode()).hexdigest()",
    "print(h(h(s['title'])+':'+h(s['body'])))",
  ].join("\n")], { input: JSON.stringify(snapshot), encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), snapshot.content_sha);
});

test("snapshot rejects PRs, other repositories and issue mismatches", async () => {
  for (const mutate of [
    (input) => { input.event.issue.pull_request = {}; },
    (input) => { input.event.repository.full_name = "attacker/project"; },
    (input) => { input.github.issue.id = 71; },
    (input) => { input.event.action = "labeled"; },
  ]) {
    const { input, github } = fixture();
    mutate(input);
    await assert.rejects(collectSnapshot(input));
    assert.equal(github.writes().length, 0);
  }
});

test("Python classifier output satisfies the independent JavaScript writer contract", async () => {
  const { input } = fixture();
  const snapshot = await collectSnapshot(input);
  const python = spawnSync(process.env.PYTHON || "python3", ["-c", [
    "import importlib.util,json,sys",
    "spec=importlib.util.spec_from_file_location('fixtures',sys.argv[1])",
    "m=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(m)",
    "s=json.load(sys.stdin)",
    "print(json.dumps(m.classifier.classify(s,m.FakeAgent(),lambda *_:(100,8000)),allow_nan=False))",
  ].join("\n"), join(__dirname, "issue-laya-classify.test.py")], {
    input: JSON.stringify(snapshot), encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(labelsFor(JSON.parse(python.stdout), input), [
    "laya:prompt-clean", "laya:well-defined", "laya:change-intent-ambiguous",
  ]);
});

test("binary categories use independent inclusive confidence gates", () => {
  for (const [key, thresholds] of [["malicious_prompt_injection", POLICY.injection], ["unsafe_changes", POLICY.unsafe]]) {
    for (const [score, index] of [[0, 1], [thresholds.negative, 1], [thresholds.negative + 0.000001, 2],
      [thresholds.positive - 0.000001, 2], [thresholds.positive, 0], [1, 0]]) {
      const { input } = fixture();
      input.decision.scores[key] = score;
      assert.equal(labelsFor(input.decision, input)[key === "unsafe_changes" ? 2 : 0], CATEGORIES[key][index][0]);
    }
  }
  const { input } = fixture();
  assert.deepEqual(labelsFor(input.decision, input), [
    "laya:prompt-clean", "laya:well-defined", "laya:change-intent-ambiguous",
  ]);
});

test("state choice requires 85% confidence rather than argmax; prechecks have no model probability", () => {
  for (const [index, choice] of ["ready", "decisions", "information"].entries()) {
    for (const confidence of [0.4, 0.849999, 0.85, 1]) {
      const { input } = fixture();
      input.decision.scores.issue_state = stateScore(choice, confidence);
      assert.equal(labelsFor(input.decision, input)[1], CATEGORIES.issue_state[confidence >= 0.85 ? index : 3][0]);
    }
  }
  for (const reason of ["empty", "template_only", "placeholder"]) {
    const { input } = fixture();
    input.decision.state_precheck = reason;
    input.decision.scores.issue_state = null;
    assert.equal(labelsFor(input.decision, input)[1], "laya:needs-details");
  }
});

test("overflow receives only ambiguous labels; partial input cannot be complete", () => {
  const { input } = fixture();
  Object.assign(input.decision, { status: "overflow", scores: Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, null])) });
  input.decision.context.truncated = true;
  assert.deepEqual(labelsFor(input.decision, input), Object.values(CATEGORIES).map((labels) => labels.at(-1)[0]));
  input.decision.status = "complete";
  assert.throws(() => labelsFor(input.decision, input), /Incomplete input/);
});

test("invalid probability, schema, model, provenance and context fail before mutation", async () => {
  const mutations = [
    ...[null, true, "0.8", NaN, Infinity, -0.1, 1.1].map((value) => (decision) => { decision.scores.malicious_prompt_injection = value; }),
    (decision) => { delete decision.scores.issue_state; },
    (decision) => { decision.version = 1; },
    (decision) => { decision.scores.issue_state = 0.9; },
    (decision) => { decision.scores.issue_state.choice = "information"; },
    (decision) => { decision.scores.issue_state.probabilities.extra = 0; },
    (decision) => { decision.scores.issue_state.probabilities.ready = 0.5; },
    (decision) => { decision.scores.issue_state.probabilities.information = NaN; },
    (decision) => { decision.state_precheck = "guessed"; },
    (decision) => { decision.state_precheck = "placeholder"; },
    (decision) => { decision.scores.issue_state = null; },
    (decision) => { decision.scores.extra = 0.1; },
    (decision) => { decision.labels = ["bug"]; },
    (decision) => { decision.model.revision = "b".repeat(40); },
    (decision) => { decision.model.subfolder = "typed-decisions"; },
    (decision) => { decision.run_id = "124"; },
    (decision) => { decision.run_attempt = "2"; },
    (decision) => { decision.repository = "attacker/project"; },
    (decision) => { decision.issue_number = 8; },
    (decision) => { decision.issue_id = 71; },
    (decision) => { decision.source_sha = "b".repeat(40); },
    (decision) => { decision.content_sha = "garbage"; },
    (decision) => { decision.context.truncated = true; },
    (decision) => { decision.context.state_tokens = 8001; },
    (decision) => { decision.context.budget = 8192; },
    (decision) => { decision.status = "error"; },
  ];
  for (const mutate of mutations) {
    const { input, github } = fixture();
    mutate(input.decision);
    await assert.rejects(reconcile(input));
    assert.equal(github.writes().length, 0);
  }
});

test("creates missing definitions and reconciles only managed labels", async () => {
  const { input, github } = fixture();
  github.issue.labels.push(...definitions.map(([name]) => ({ name })));
  const result = await reconcile(input);
  assert.equal(result.status, "applied");
  assert.equal(github.definitions.length, 10);
  for (const [name, color, description] of definitions) {
    assert.ok(name.length <= 50);
    assert.match(color, /^[a-f0-9]{6}$/);
    assert.ok(description.length <= 100);
  }
  const labels = github.issue.labels.map((label) => label.name);
  assert.deepEqual(labels.filter((name) => !managed.has(name)), ["bug", "high", "copilot:plan-and-implement"]);
  assert.deepEqual(labels.filter((name) => managed.has(name)).sort(), [...result.labels].sort());
  assert.equal(github.calls.filter(([method]) => method === "removeLabel").length, 7);
  assert.ok(github.writes().every(([method]) => ["createLabel", "updateLabel", "addLabels", "removeLabel"].includes(method)));
});

test("legacy labels migrate on reassessment without deleting definitions or unrelated metadata", async () => {
  const { input, github } = fixture();
  github.issue.labels.push(...LEGACY.map((name) => ({ name })));
  github.definitions.push({ name: "bug", color: "123456", description: "Human metadata" },
    { name: "laya:prompt-clean", color: "000000", description: "Old policy" },
    ...LEGACY.map((name) => ({ name, color: "000000", description: "Legacy" })));
  await reconcile(input);
  assert.ok(!github.issue.labels.some(({ name }) => LEGACY.includes(name)));
  assert.ok(LEGACY.every((name) => github.definitions.some((label) => label.name === name)));
  assert.deepEqual(github.definitions[0], { name: "bug", color: "123456", description: "Human metadata" });
  assert.equal(github.calls.filter(([method]) => method === "updateLabel").length, 1);
  assert.equal(github.definitions.find(({ name }) => name === "laya:prompt-clean").description,
    CATEGORIES.malicious_prompt_injection[1][2]);
});

test("dry-run validates freshness and reports changes with zero label mutations", async () => {
  const { input, github } = fixture();
  input.dryRun = true;
  github.issue.labels.push(...LEGACY.map((name) => ({ name })));
  const result = await reconcile(input);
  assert.equal(result.status, "dry-run");
  assert.equal(result.additions.length, 3);
  assert.deepEqual(result.removals, LEGACY);
  assert.deepEqual(github.writes(), []);
  github.issue.body += " changed";
  assert.equal((await reconcile(input)).status, "stale");
  assert.deepEqual(github.writes(), []);
});

test("a configured dry-run cannot reach writes and invalid schemas still fail in dry-run", async () => {
  const { input, github } = fixture();
  input.dryRunVariable = "true";
  await assert.rejects(reconcile(input), /forbids writes/);
  input.dryRun = true;
  input.decision.version = 1;
  await assert.rejects(reconcile(input), /Unsupported/);
  assert.deepEqual(github.writes(), []);
});

test("already-correct labels are idempotent and unrelated definitions are not edited", async () => {
  const { input, github } = fixture();
  await reconcile(input);
  github.calls = [];
  const result = await reconcile(input);
  assert.equal(result.status, "unchanged");
  assert.deepEqual(github.writes(), []);
});

test("content edits before and during label setup withhold issue mutations", async () => {
  for (const staleAt of [1, 2]) {
    const { input, github } = fixture();
    github.onGet = (count) => {
      if (count === staleAt) github.issue.body += " Changed.";
    };
    const result = await reconcile(input);
    assert.equal(result.status, "stale");
    assert.ok(!github.writes().some(([method]) => ["addLabels", "removeLabel"].includes(method)));
    if (staleAt === 1) assert.deepEqual(github.writes(), []);
  }
});

test("late content and managed-label races are reported instead of claiming success", async () => {
  const stale = fixture();
  stale.github.onGet = (count) => {
    if (count === 3) stale.github.issue.title += " changed";
  };
  const result = await reconcile(stale.input);
  assert.equal(result.status, "stale");
  assert.match(result.reason, /applied labels may be stale/);
  const conflicting = fixture();
  conflicting.github.onGet = (count) => {
    if (count === 3) conflicting.github.issue.labels.push({ name: "laya:malicious-prompt-injection" });
  };
  await assert.rejects(reconcile(conflicting.input), /changed concurrently/);
});

test("partial reconciliation can be retried without losing unrelated labels", async () => {
  const { input, github } = fixture();
  github.issue.labels.push({ name: "laya:prompt-injection" }, { name: "laya:needs-information" });
  let removed = false;
  github.fail = (method) => {
    if (method === "removeLabel" && !removed) {
      removed = true;
      throw Object.assign(new Error("API unavailable"), { status: 503 });
    }
  };
  await assert.rejects(reconcile(input), /API unavailable/);
  github.fail = null;
  await reconcile(input);
  assert.equal(github.issue.labels.filter(({ name }) => managed.has(name)).length, 3);
  assert.ok(github.issue.labels.some(({ name }) => name === "bug"));
});

test("only verified concurrent label-creation conflicts are tolerated", async () => {
  for (const errors of [
    [{ resource: "Label", code: "already_exists", field: "name" }],
    [{ resource: "Label", code: "invalid", field: "color" }],
  ]) {
    const { input, github } = fixture();
    github.fail = (method) => {
      if (method === "createLabel") throw Object.assign(new Error("Unprocessable"), { status: 422, response: { data: { errors } } });
    };
    if (errors[0].code === "already_exists") assert.equal((await reconcile(input)).status, "applied");
    else await assert.rejects(reconcile(input), /Unprocessable/);
  }
});

test("only genuinely absent labels tolerate a removal 404; all other API errors surface", async () => {
  for (const disappeared of [true, false]) {
    const { input, github } = fixture();
    github.issue.labels.push({ name: "laya:prompt-injection" });
    github.fail = (method, parameters) => {
      if (method !== "removeLabel") return;
      if (disappeared) github.issue.labels = github.issue.labels.filter(({ name }) => name !== parameters.name);
      throw Object.assign(new Error("Not found"), { status: 404 });
    };
    if (disappeared) assert.equal((await reconcile(input)).status, "applied");
    else await assert.rejects(reconcile(input), /Could not remove/);
  }
  const { input, github } = fixture();
  github.fail = () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
  await assert.rejects(reconcile(input), /Forbidden/);
});

test("manual configuration defaults preserve automatic writes and validate every manual target", async () => {
  const { input, github } = fixture();
  assert.equal(runConfiguration(input).dryRun, false);
  assert.equal(runConfiguration({ ...input, dryRunVariable: "true" }).dryRun, true);
  input.eventName = "workflow_dispatch";
  input.event = { repository: { full_name: input.repository, default_branch: "main" },
    inputs: { operation: "assess", issue_number: "7", dry_run: "true" } };
  assert.deepEqual(runConfiguration(input), { operation: "assess", issueNumber: 7, dryRun: true });
  assert.equal((await collectSnapshot(input)).issue_id, 70);
  input.dryRun = true;
  assert.equal((await reconcile(input)).status, "dry-run");
  assert.deepEqual(github.writes(), []);
  for (const change of [
    { ref: "refs/heads/untrusted" }, { eventName: "pull_request_target" }, { dryRunVariable: "yes" },
    ...["", "0", "-1", "7;echo", "9007199254740992"].map((value) => ({
      event: { ...input.event, inputs: { ...input.event.inputs, issue_number: value } },
    })),
  ]) assert.throws(() => runConfiguration({ ...input, ...change }));
  input.event.inputs = { operation: "warm-cache", issue_number: "", dry_run: "true" };
  assert.deepEqual(runConfiguration(input), { operation: "warm-cache", issueNumber: null, dryRun: true });
  await assert.rejects(collectSnapshot(input), /Unexpected assessment/);
  input.event.inputs.issue_number = "7";
  assert.throws(() => runConfiguration(input), /does not accept/);
  input.event.inputs = { operation: "assess", issue_number: "7", dry_run: "false" };
  github.issue.pull_request = {};
  await assert.rejects(collectSnapshot(input), /Live issue/);
});

test("manual writes retain issue-ID guards and the repository dry-run override", async () => {
  const { input, github } = fixture();
  input.eventName = "workflow_dispatch";
  input.event = { repository: { full_name: input.repository, default_branch: "main" },
    inputs: { operation: "assess", issue_number: "7", dry_run: "false" } };
  input.dryRunVariable = "true";
  await assert.rejects(reconcile(input), /forbids writes/);
  input.dryRunVariable = "false";
  input.decision.issue_id++;
  await assert.rejects(reconcile(input), /Decision issue ID/);
  assert.deepEqual(github.writes(), []);
  input.decision.issue_id--;
  assert.equal((await reconcile(input)).status, "applied");
  assert.ok(github.writes().length > 0);
});

test("workflow wires optional dry-run, manual warming, local inference and a separate trusted writer", () => {
  const requireEvaluator = createRequire(join(__dirname, "../../evaluator/package.json"));
  const { parse } = requireEvaluator("yaml");
  const workflow = parse(readFileSync(join(__dirname, "../workflows/issue-laya-labeling.yml"), "utf8"));
  assert.deepEqual(workflow.on.issues, { types: ["opened", "edited", "reopened"] });
  assert.deepEqual(Object.keys(workflow.on).sort(), ["issues", "workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, ["assess", "warm-cache"]);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(workflow.concurrency.group, /github\.event\.issue\.number/);
  assert.deepEqual(workflow.jobs.classify.permissions, { contents: "read", issues: "read" });
  assert.deepEqual(workflow.jobs.label.permissions, { contents: "read", issues: "write" });
  for (const job of Object.values(workflow.jobs)) {
    assert.doesNotMatch(JSON.stringify(job.env ?? {}), /\brunner\s*\./,
      "The runner context is unavailable in job-level env");
  }
  assert.equal(workflow.jobs.label.needs, "classify");
  assert.match(workflow.jobs.label.if, /operation == 'assess'.*dry_run == 'false'/);
  const classification = workflow.jobs.classify.steps;
  const writer = workflow.jobs.label.steps;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const step of [...classification, ...writer]) {
    if (step.uses?.startsWith("actions/github-script@")) {
      assert.doesNotThrow(() => new AsyncFunction("github", "context", "core", step.with.script));
    }
  }
  const inference = classification.find((step) => step.name === "Classify issue text as data");
  assert.match(inference.run, /issue-laya-classify\.py/);
  assert.deepEqual(inference.env, { HF_HOME: "${{ runner.temp }}/issue-laya-hub" });
  const modelCache = classification.find((step) => step.name === "Cache pinned model download");
  assert.equal(modelCache.with.path, inference.env.HF_HOME);
  assert.match(modelCache.with.key, /configuration\.outputs\.model_key/);
  assert.doesNotMatch(modelCache.with.key, /classify\.py/);
  const configuration = classification.find((step) => step.id === "configuration");
  assert.equal(configuration.env.LAYA_DRY_RUN, "${{ vars.LAYA_DRY_RUN }}");
  assert.match(configuration.with.script, /JSON\.stringify\(MODEL\)/);
  const warming = classification.find((step) => step.name === "Warm pinned model cache");
  assert.match(warming.if, /operation == 'warm-cache'/);
  assert.match(warming.run, /--warm-cache/);
  for (const name of ["Collect current title and description", "Classify issue text as data",
    "Validate and summarize assessment", "Upload validated decision only"]) {
    assert.match(classification.find((step) => step.name === name).if, /operation == 'assess'/);
  }
  const preview = classification.find((step) => step.name === "Validate and summarize assessment");
  assert.match(preview.with.script, /dryRun: true/);
  assert.equal(classification[0].name, "Require trusted manual revision");
  assert.ok(!JSON.stringify(workflow.jobs.classify.env).match(/TOKEN|github\.token|secrets/));
  assert.ok(!JSON.stringify(writer).match(/pip install|issue-laya-classify\.py|laya\.load/));
  for (const steps of [classification, writer]) {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with["persist-credentials"], false);
  }
  assert.equal(classification.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref, "${{ github.sha }}");
  assert.equal(writer[0].with.ref, "${{ needs.classify.outputs.source_sha }}");
  const upload = classification.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const download = writer.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(upload.with.name, download.with.name);
  assert.match(upload.with.name, /github\.run_id.*github\.run_attempt/);
  assert.match(upload.with.path, /\/decision\.json$/);
  assert.match(classification.find((step) => step.name === "Install CPU inference dependencies").run,
    /--index-url https:\/\/download\.pytorch\.org\/whl\/cpu/);
  const requirements = readFileSync(join(__dirname, "issue-laya-requirements.txt"), "utf8");
  assert.ok(requirements.includes(`laya==${MODEL.runtime}`));
  assert.ok(!JSON.stringify(workflow).match(/github\.event\.issue\.(title|body)/));
  const python = readFileSync(join(__dirname, "issue-laya-classify.py"), "utf8");
  assert.ok(python.includes(MODEL.revision));
  assert.ok(python.includes(`"runtime": "${MODEL.runtime}"`));
});
