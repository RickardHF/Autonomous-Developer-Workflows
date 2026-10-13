const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { isAbsolute, join, resolve } = require("node:path");
const { test } = require("node:test");
const helpers = require("./trivial-pr-automerge.cjs");
const {
  LIMITS, eligibility, collectChanges, collectSnapshot, validateSnapshot, validateDecision,
  runCopilot, classifySnapshot, validateAssessment, readRequiredChecks, mergeIfReady,
  confirmMerged, deleteSourceBranch, dispatchEvaluation,
} = helpers;

const REPOSITORY = "example/project";
const RUN_ID = "123";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const REASON = "Isolated reversible bug fix with focused regression coverage and no security or data impact.";
const clone = (value) => structuredClone(value);
const event = () => ({
  action: "submitted", review: { id: 70, state: "approved", commit_id: HEAD },
  pull_request: {
    number: 7, state: "open", draft: false,
    head: { sha: HEAD, ref: "feature/fix", repo: { full_name: REPOSITORY } },
    base: { sha: BASE, ref: "main", repo: { full_name: REPOSITORY } },
  },
});
const snapshot = () => ({
  version: 1, repository: REPOSITORY, run_id: RUN_ID, pr_number: 7, review_id: 70,
  base_sha: BASE, head_sha: HEAD, head_ref: "feature/fix", merge_base_sha: BASE,
  eligible: true, complete: true, changed_lines: 2,
  changes: [{ path: "src/fix.js", status: "M", old_mode: "100644", new_mode: "100644", before: "false\n", after: "true\n" }],
});
const decision = (trivial = true) => ({
  repository: REPOSITORY, run_id: RUN_ID, pr_number: 7, review_id: 70,
  base_sha: BASE, head_sha: HEAD, head_ref: "feature/fix",
  status: "complete", trivial, reason: REASON,
});
const compactEvent = () => ({
  action: "submitted", review: { id: 70, state: "APPROVED", commit_id: HEAD },
  pull_request: {
    number: 7,
    head: { sha: HEAD, ref: "feature/fix", repo: { id: 100 } },
    base: { sha: BASE, ref: "main", repo: { id: 100 } },
  },
});

function fakeGithub() {
  const github = {
    calls: [], pr: clone(event().pull_request), review: { id: 70, state: "APPROVED", commit_id: HEAD },
    gate: { headRefOid: HEAD, baseRefOid: BASE, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
    repo: { default_branch: "main" }, branch: { protected: false },
    ref: { object: { type: "commit", sha: HEAD } }, open: [],
    mergeResponse: { merged: true, sha: MERGE }, errors: {},
    writes() { return this.calls.filter(({ route }) => /^(PUT|POST|DELETE) /.test(route)); },
    async request(route, parameters) {
      this.calls.push({ route, parameters: clone(parameters) });
      if (this.errors[route]) throw this.errors[route];
      let data;
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") data = this.pr;
      else if (route.endsWith("/reviews/{review_id}")) data = this.review;
      else if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
        data = this.mergeResponse;
        if (data.merged) Object.assign(this.pr, { merged: true, state: "closed", merge_commit_sha: data.sha });
      } else if (route === "GET /repos/{owner}/{repo}") data = this.repo;
      else if (route === "GET /repos/{owner}/{repo}/branches/{branch}") data = this.branch;
      else if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") data = this.ref;
      else if (route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}" ||
          route === "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches") data = {};
      else throw new Error(`Unexpected API request: ${route}`);
      return { data: clone(data) };
    },
    async graphql(query, parameters) {
      this.calls.push({ route: "GRAPHQL", parameters: clone(parameters) });
      assert.match(query, /headRefOid baseRefOid/);
      if (!query.includes("mergeStateStatus")) assert.doesNotMatch(query, /reviewDecision/);
      return { repository: { pullRequest: clone(this.gate) } };
    },
    async paginate(route, parameters) {
      this.calls.push({ route, parameters: clone(parameters) });
      assert.equal(route, "GET /repos/{owner}/{repo}/pulls");
      return clone(this.open);
    },
  };
  return github;
}

function collectionGit(_cwd, args) {
  if (args[0] === "rev-parse") return Buffer.from(`${args[1] === "HEAD" ? BASE : HEAD}\n`);
  if (args.includes("fetch")) return Buffer.from("");
  if (args[0] === "merge-base") return Buffer.from(`${BASE}\n`);
  if (args.includes("--raw")) return Buffer.from(":100644 100644 aaaaaaa bbbbbbb M\0src/fix.js\0");
  if (args.includes("--numstat")) return Buffer.from("1\t1\tsrc/fix.js\0");
  if (args[0] === "cat-file") return Buffer.from("2\n");
  if (args[0] === "show") return Buffer.from(args.at(-1).startsWith(BASE) ? "a\n" : "b\n");
  assert.fail(`Unexpected git invocation: ${args}`);
}

function mergeFixture() {
  const { github, input } = fixture();
  return {
    github,
    input: { ...input, decision: decision(), attempts: 2,
      readChecks: () => ({ pending: false, failed: false, reported: true, reason: "Required checks passed" }),
      pause: () => assert.fail("Ready PRs should not wait") },
  };
}

function mergedFixture() {
  const { github, input } = fixture();
  Object.assign(github.pr, { merged: true, state: "closed", merge_commit_sha: MERGE });
  return { github, input: { ...input, mergeSha: MERGE } };
}

function fixture() {
  const github = fakeGithub();
  const input = { github, event: event(), repository: REPOSITORY, runId: RUN_ID, snapshot: snapshot() };
  return { github, input };
}

function gitFixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "trivial-pr-git-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: directory, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Workflow fixture");
  git("config", "user.email", "fixture@example.invalid");
  const write = (name, content) => {
    mkdirSync(resolve(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), content);
  };
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "-m", "Fixture commit");
    return git("rev-parse", "HEAD");
  };
  write("src/fix.js", "const enabled = false;\n");
  const base = commit();
  return { directory, git, write, commit, base };
}

function addedFiles(contents, lineCounts = contents.map(() => 1)) {
  const names = contents.map((_, index) => `file-${index}.txt`);
  const runGit = (_cwd, args) => {
    if (args[0] === "merge-base") return Buffer.from(`${BASE}\n`);
    if (args.includes("--raw")) return Buffer.from(names.map((name) => `:000000 100644 0000000 bbbbbbb A\0${name}\0`).join(""));
    if (args.includes("--numstat")) return Buffer.from(names.map((name, index) => `${lineCounts[index]}\t0\t${name}\0`).join(""));
    const name = args.at(-1).slice(41);
    const value = Buffer.from(contents[names.indexOf(name)]);
    if (args[0] === "cat-file") return Buffer.from(`${value.length}\n`);
    assert.equal(args[0], "show");
    return value;
  };
  return () => collectChanges({ cwd: ".", baseSha: BASE, headSha: HEAD, runGit });
}

test("only submitted current-head approvals on same-repository, open, non-draft main PRs are eligible", () => {
  assert.equal(eligibility(event(), REPOSITORY), null);
  for (const mutate of [
    (e) => { e.action = "edited"; }, (e) => { e.action = "dismissed"; },
    (e) => { e.review.state = "commented"; }, (e) => { e.review.state = "changes_requested"; },
    (e) => { e.pull_request.draft = true; }, (e) => { e.pull_request.state = "closed"; },
    (e) => { e.pull_request.base.ref = "release"; }, (e) => { e.pull_request.head.repo.full_name = "fork/project"; },
    (e) => { e.pull_request.head.repo = null; }, (e) => { e.review.commit_id = BASE; },
  ]) {
    const value = event();
    mutate(value);
    assert.equal(typeof eligibility(value, REPOSITORY), "string");
  }
  const invalid = event();
  invalid.pull_request.head.sha = "not-a-sha";
  assert.throws(() => eligibility(invalid, REPOSITORY), /Invalid PR revision/);
});

test("decisions require exact fields, actual booleans, and a substantive bounded reason", () => {
  assert.deepEqual(validateDecision({ trivial: false, reason: REASON }), { trivial: false, reason: REASON });
  assert.deepEqual(validateDecision({ trivial: true, reason: REASON }), { trivial: true, reason: REASON });
  for (const value of [
    null, [], {}, { trivial: "true", reason: REASON }, { trivial: 1, reason: REASON },
    { trivial: true, reason: "small" }, { trivial: true, reason: " ".repeat(20) },
    { trivial: true, reason: "x".repeat(4001) }, { trivial: true, reason: REASON, pr_number: 99 },
  ]) assert.throws(() => validateDecision(value), /Copilot must return exactly/);
});

test("snapshot identity is bound to the original review, run, PR, repository, and revisions", () => {
  const input = fixture().input;
  assert.equal(validateSnapshot(input.snapshot, input), input.snapshot);
  for (const [field, value] of Object.entries({
    version: 2, repository: "other/project", run_id: "999", pr_number: 8, review_id: 71,
    head_sha: BASE, base_sha: HEAD, head_ref: "main", complete: false, eligible: false,
    merge_base_sha: "", changes: [],
  })) assert.throws(() => validateSnapshot({ ...input.snapshot, [field]: value }, input), /snapshot does not match/);
});

test("classification rechecks live state after inference and binds completed decisions to revisions", async () => {
  for (const trivial of [true, false]) {
    const { github, input } = fixture();
    let inferred = false;
    const request = github.request.bind(github);
    github.request = (...args) => {
      assert.equal(inferred, true);
      return request(...args);
    };
    const result = await classifySnapshot({
      ...input, snapshotPath: "snapshot.json",
      run: () => {
        inferred = true;
        return { status: 0, stdout: JSON.stringify({ trivial, reason: REASON }), stderr: "" };
      },
    });
    assert.deepEqual(result, { status: "complete", trivial, reason: REASON,
      repository: REPOSITORY, run_id: RUN_ID, pr_number: 7, head_ref: "feature/fix",
      base_sha: BASE, head_sha: HEAD, review_id: 70 });
    assert.equal(github.calls.length, 3);
    assert.deepEqual(github.writes(), []);
  }
});

test("approval and PR changes during inference withhold the classification verdict", async () => {
  for (const mutate of [
    (g) => { g.review.state = "DISMISSED"; },
    (g) => { g.review.commit_id = BASE; },
    (g) => { g.review.id = 71; },
    (g) => { g.pr.head.sha = BASE; },
    (g) => { g.pr.base.sha = HEAD; },
    (g) => { g.gate.headRefOid = BASE; },
    (g) => { g.gate.baseRefOid = HEAD; },
    (g) => { g.pr.state = "closed"; },
    (g) => { g.pr.merged = true; },
    (g) => { g.pr.draft = true; },
    (g) => { g.pr.head.ref = "other"; },
    (g) => { g.pr.head.repo = null; },
    (g) => { g.pr.base.ref = "release"; },
    (g) => { g.pr.base.repo.full_name = "other/project"; },
  ]) {
    const { github, input } = fixture();
    let captured;
    const result = await classifySnapshot({
      ...input, snapshotPath: "snapshot.json",
      run: () => {
        mutate(github);
        return { status: 0, stdout: JSON.stringify({ trivial: true, reason: REASON }), stderr: "" };
      },
      onOutput: (raw) => { captured = raw; },
    });
    assert.equal(result.status, "stale");
    assert.equal(Object.hasOwn(result, "trivial"), false);
    assert.equal(typeof result.reason, "string");
    assert.equal(result.head_sha, HEAD);
    assert.equal(result.base_sha, BASE);
    assert.equal(result.review_id, 70);
    assert.equal(JSON.parse(captured).trivial, true);
    assert.deepEqual(github.writes(), []);
  }
});

test("classification fails closed when the final freshness check cannot complete", async () => {
  for (const mutate of [
    (g) => { g.request = async () => { throw new Error("GitHub unavailable"); }; },
    (g) => { g.gate = null; },
  ]) {
    const { github, input } = fixture();
    await assert.rejects(classifySnapshot({
      ...input, snapshotPath: "snapshot.json",
      run: () => {
        mutate(github);
        return { status: 0, stdout: JSON.stringify({ trivial: true, reason: REASON }), stderr: "" };
      },
    }), /GitHub unavailable|GitHub did not return PR revisions/);
  }
  const { github, input } = fixture();
  await assert.rejects(classifySnapshot({
    ...input, snapshot: { ...input.snapshot, head_sha: BASE }, snapshotPath: "snapshot.json",
    run: () => assert.fail("Invalid snapshots must not reach Copilot"),
  }), /snapshot does not match/);
  assert.deepEqual(github.calls, []);
});

test("change collection preserves full before/after content and unusual filenames without executing candidate code", (context) => {
  const f = gitFixture(context);
  f.write("src/fix.js", "throw new Error('must never execute candidate code');\n");
  f.write("file with\ttab\nand newline.txt", "candidate context\n");
  const head = f.commit();
  f.git("update-ref", "refs/pull/7/head", head);
  f.git("checkout", "--quiet", "--detach", f.base);
  f.git("remote", "add", "origin", f.directory);
  const result = collectChanges({ cwd: f.directory, baseSha: f.base, headSha: head });
  assert.equal(result.complete, true);
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes.find((change) => change.path === "src/fix.js").before, "const enabled = false;\n");
  assert.match(result.changes.find((change) => change.path === "src/fix.js").after, /must never execute/);
  assert.equal(result.changes.find((change) => change.path.includes("\t")).after, "candidate context\n");
  assert.equal(f.git("rev-parse", "HEAD"), f.base);
  assert.equal(readFileSync(join(f.directory, "src/fix.js"), "utf8"), "const enabled = false;\n");
});

test("renames are reviewed as complete deletion and addition rather than omitted content", (context) => {
  const f = gitFixture(context);
  f.git("mv", "src/fix.js", "src/renamed.js");
  const head = f.commit();
  const result = collectChanges({ cwd: f.directory, baseSha: f.base, headSha: head });
  assert.equal(result.complete, true);
  assert.deepEqual(result.changes.map(({ status }) => status), ["D", "A"]);
  assert.equal(result.changes[0].before, "const enabled = false;\n");
  assert.equal(result.changes[0].after, null);
  assert.equal(result.changes[1].before, null);
  assert.equal(result.changes[1].after, result.changes[0].before);
});

test("complete snapshots fetch objects only and refuse untrusted checkouts or changed heads", async (context) => {
  const f = gitFixture(context);
  f.write("src/fix.js", "const enabled = true;\n");
  const head = f.commit();
  f.git("update-ref", "refs/pull/7/head", head);
  f.git("checkout", "--quiet", "--detach", f.base);
  f.git("remote", "add", "origin", f.directory);
  const input = fixture().input;
  input.event.pull_request.base.sha = f.base;
  input.event.pull_request.head.sha = head;
  input.event.review.commit_id = head;
  input.github.pr = clone(input.event.pull_request);
  input.github.review.commit_id = head;
  input.github.gate.baseRefOid = f.base;
  input.github.gate.headRefOid = head;
  const result = await collectSnapshot({ ...input, cwd: f.directory });
  assert.equal(result.eligible, true);
  assert.equal(result.merge_base_sha, f.base);
  assert.equal(f.git("rev-parse", "HEAD"), f.base);
  assert.deepEqual(input.github.writes(), []);
  f.git("checkout", "--quiet", "--detach", head);
  await assert.rejects(collectSnapshot({ ...input, cwd: f.directory }), /trusted PR base/);
  f.git("checkout", "--quiet", "--detach", f.base);
  f.git("update-ref", "refs/pull/7/head", f.base);
  assert.match((await collectSnapshot({ ...input, cwd: f.directory })).reason, /head changed during collection/);
});

test("review limits are inclusive and exceeding any limit prevents classification", () => {
  assert.equal(addedFiles(Array(LIMITS.files).fill("x"))().complete, true);
  assert.match(addedFiles(Array(LIMITS.files + 1).fill("x"))().reason, /file review limit/);
  assert.equal(addedFiles(["x"], [LIMITS.lines])().complete, true);
  assert.match(addedFiles(["x"], [LIMITS.lines + 1])().reason, /changed-line/);
  assert.equal(addedFiles(["x".repeat(LIMITS.fileBytes)])().complete, true);
  assert.match(addedFiles(["x".repeat(LIMITS.fileBytes + 1)])().reason, /file exceeds/);
  const overhead = Buffer.byteLength(JSON.stringify(addedFiles(["", ""])()));
  const payload = LIMITS.contextBytes - overhead;
  const contents = ["x".repeat(Math.floor(payload / 2)), "x".repeat(Math.ceil(payload / 2))];
  const atLimit = addedFiles(contents)();
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit)), LIMITS.contextBytes);
  assert.equal(atLimit.complete, true);
  contents[0] += "x";
  assert.match(addedFiles(contents)().reason, /total review context limit/);
});

test("valid triggering approvals can be classified without aggregate merge approval", async (context) => {
  const f = gitFixture(context);
  f.write("src/fix.js", "const enabled = true;\n");
  const head = f.commit();
  f.git("update-ref", "refs/pull/7/head", head);
  f.git("checkout", "--quiet", "--detach", f.base);
  f.git("remote", "add", "origin", f.directory);
  const input = fixture().input;
  input.event.pull_request.base.sha = f.base;
  input.event.pull_request.head.sha = head;
  input.event.review.commit_id = head;
  input.github.pr = clone(input.event.pull_request);
  input.github.review.commit_id = head;
  input.github.gate.baseRefOid = f.base;
  input.github.gate.headRefOid = head;
  for (const decision of [null, "REVIEW_REQUIRED", "CHANGES_REQUESTED"]) {
    input.github.gate.reviewDecision = decision;
    const result = await collectSnapshot({ ...input, cwd: f.directory });
    assert.equal(result.eligible, true);
    assert.equal(result.complete, true);
    assert.deepEqual(input.github.writes(), []);
  }
  input.github.review.state = "DISMISSED";
  assert.match((await collectSnapshot({ ...input, cwd: f.directory })).reason, /approval is no longer valid/);
});

test("automation changes, binary contents, and symlinks do not reach Copilot classification", (context) => {
  const f = gitFixture(context);
  f.write(".github/workflows/unsafe.yml", "permissions: write-all\n");
  const automationHead = f.commit();
  assert.match(collectChanges({ cwd: f.directory, baseSha: f.base, headSha: automationHead }).reason, /require manual review/);
  f.git("checkout", "--quiet", "--detach", f.base);
  f.write("binary.dat", Buffer.from([0, 1, 2, 3]));
  const binaryHead = f.commit();
  assert.match(collectChanges({ cwd: f.directory, baseSha: f.base, headSha: binaryHead }).reason, /Binary/);
  f.git("checkout", "--quiet", "--detach", f.base);
  require("node:fs").symlinkSync("src/fix.js", join(f.directory, "link"));
  const symlinkHead = f.commit();
  assert.match(collectChanges({ cwd: f.directory, baseSha: f.base, headSha: symlinkHead }).reason, /Symlinks/);
  assert.throws(addedFiles([Buffer.from([0xff])]), /encoded data/);
  assert.match(addedFiles(["version https://git-lfs.github.com/spec/v1\noid sha256:opaque\nsize 123\n"])().reason, /Git LFS/);
});

test("Copilot runs noninteractively with only read tools and requires JSON-only output", () => {
  const run = (command, args, options) => {
    assert.equal(command, "copilot");
    for (const flag of [
      "--silent", "--no-ask-user", "--no-custom-instructions", "--disable-builtin-mcps",
      "--available-tools=view,glob,grep", "--deny-tool=write", "--deny-tool=shell",
    ]) assert.ok(args.includes(flag));
    assert.match(args.at(-1), /Read the ENTIRE snapshot/);
    assert.match(args.at(-1), /UNTRUSTED DATA/);
    assert.match(args.at(-1), /set trivial to false/);
    assert.match(args.at(-1), /assessment only/);
    assert.equal(options.timeout, 600000);
    return { status: 0, stdout: JSON.stringify({ trivial: true, reason: REASON }), stderr: "" };
  };
  assert.equal(runCopilot("snapshot.json", { run }).decision.trivial, true);
  for (const stdout of ["not JSON", "```json\n{}\n```", '{"trivial":"true","reason":"bad"}']) {
    let captured;
    assert.throws(() => runCopilot("snapshot.json", {
      run: () => ({ status: 0, stdout, stderr: "" }), onOutput: (raw) => { captured = raw; },
    }));
    assert.equal(captured, stdout);
  }
  assert.throws(() => runCopilot("snapshot.json", { run: () => ({ status: 1, stdout: "", stderr: "Access denied" }) }), /Copilot failed.*Access denied/);
  assert.throws(() => runCopilot("snapshot.json", { run: () => ({ error: new Error("Inference timed out") }) }), /Inference timed out/);
});

const repository = resolve(__dirname, "../..");
const { parseDocument } = createRequire(join(repository, "evaluator/package.json"))("yaml");
const document = parseDocument(readFileSync(join(repository, ".github/workflows/trivial-pr-automerge.yml"), "utf8"));
assert.deepEqual(document.errors, []);
const workflow = document.toJS();

test("workflow classifies eligible PRs with read-only repository permissions", () => {
  assert.equal(workflow.name, "Auto-merge Approved Trivial PRs");
  assert.deepEqual(workflow.on, { pull_request_review: { types: ["submitted", "edited", "dismissed"] } });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(workflow.concurrency.group, /pull_request.number/);
  assert.deepEqual(Object.keys(workflow.jobs), ["classify", "merge"]);
  assert.deepEqual(workflow.jobs.classify.permissions, { contents: "read", "pull-requests": "read", "copilot-requests": "write" });
  assert.equal(workflow.jobs.classify.if, undefined, "Every review event must reach diagnostics");
  const preflight = workflow.jobs.classify.steps.find((step) => step.id === "preflight");
  assert.match(preflight.with.script, /github.rest.pulls.get/);
  const checkout = workflow.jobs.classify.steps.find((step) => step.uses === "actions/checkout@v7");
  assert.equal(checkout.with.ref, "${{ steps.preflight.outputs.base_sha }}");
  assert.equal(checkout.if, "steps.preflight.outputs.ready == 'true'");
  assert.equal(checkout.with["persist-credentials"], false);
  const cli = workflow.jobs.classify.steps.find((step) => step.id === "classify");
  assert.equal(cli.env.COPILOT_GITHUB_TOKEN, "${{ github.token }}");
  assert.match(cli.with.script, /await classifySnapshot\(/);
  assert.match(cli.with.script, /decision.status === "stale" \? "Stale: assessment withheld"/);
  assert.ok(cli.with.script.indexOf("await classifySnapshot(") <
    cli.with.script.indexOf('fs.writeFileSync(path.join(directory, "decision.json")'));
  assert.match(cli.with.script, /setOutput\("trivial", String\(decision.status === "complete" && decision.trivial === true\)\)/);
  assert.equal(workflow.jobs.classify.steps.some((step) => /mergeIfReady|deleteSourceBranch|dispatchEvaluation/.test(step.with?.script)), false);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps.filter((step) => step.run)) {
      const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    for (const step of job.steps.filter((step) => step.with?.script)) {
      assert.doesNotThrow(() => new (Object.getPrototypeOf(async function () {}).constructor)(step.with.script));
    }
  }
});

test("abbreviated review payloads are hydrated from GitHub before eligibility, for Copilot and humans", async () => {
  for (const login of ["copilot-pull-request-reviewer[bot]", "human-reviewer"]) {
    const { github, input } = fixture();
    input.event = compactEvent();
    github.review.user = { login };
    const result = await collectSnapshot({ ...input, cwd: ".", runGit: collectionGit });
    assert.equal(result.eligible, true);
    assert.equal(result.review_id, 70);
    assert.equal(result.head_sha, HEAD);
    assert.equal(result.base_sha, BASE);
    assert.equal(result.changes.length, 1);
    assert.doesNotThrow(() => validateSnapshot(result, input));
    assert.deepEqual(github.writes(), []);
  }
});

test("hydration cannot turn a comment, stale review, closed PR, or fork into an eligible approval", async () => {
  for (const mutate of [
    (i) => { i.event.review.state = "commented"; },
    (i) => { i.event.review.state = undefined; },
    (i) => { i.github.review.state = "DISMISSED"; },
    (i) => { i.github.review.commit_id = BASE; },
    (i) => { i.github.pr.state = "closed"; },
    (i) => { i.github.pr.draft = true; },
    (i) => { i.github.pr.head.repo.full_name = "fork/project"; },
    (i) => { i.github.pr.base.ref = "release"; },
    (i) => { i.event.pull_request.head.sha = BASE; },
    (i) => { i.event.pull_request.base.sha = HEAD; },
    (i) => { i.event.review.commit_id = BASE; },
  ]) {
    const input = fixture().input;
    input.event = compactEvent();
    mutate(input);
    const result = await collectSnapshot({ ...input, cwd: ".", runGit: () => assert.fail("Ineligible PRs must not be fetched") });
    assert.equal(result.eligible, false);
    assert.equal(typeof result.reason, "string");
    assert.deepEqual(input.github.writes(), []);
  }
});

test("malformed review identities and API failures fail before change collection", async () => {
  for (const mutate of [
    (i) => { i.event.review.id = 0; },
    (i) => { i.event.pull_request.number = "7"; },
    (i) => { i.github.review.id = 71; },
    (i) => { i.github.pr.number = 8; },
    (i) => { i.github.request = async () => { throw new Error("GitHub unavailable"); }; },
  ]) {
    const input = fixture().input;
    input.event = compactEvent();
    mutate(input);
    await assert.rejects(collectSnapshot({ ...input, cwd: ".", runGit: () => assert.fail("No Git access expected") }),
      /Invalid PR or review number|different PR or review|GitHub unavailable/);
  }
});

test("API and event approval state casing is normalized without relying on review text", async () => {
  for (const state of ["approved", "APPROVED", "Approved"]) {
    const input = fixture().input;
    input.event.review.state = state;
    input.github.review.state = state;
    assert.equal(eligibility(input.event, REPOSITORY), null);
    assert.equal((await collectSnapshot({ ...input, cwd: ".", runGit: collectionGit })).eligible, true);
  }
  const input = fixture().input;
  input.event.review.state = "commented";
  input.event.review.body = "Approved";
  assert.equal((await collectSnapshot({ ...input, cwd: ".", runGit: collectionGit })).eligible, false);
});

test("completed merge decisions are bound to the snapshot, not just a trivial boolean", () => {
  assert.equal(validateAssessment(decision(), snapshot()).trivial, true);
  for (const [field, value] of Object.entries({
    status: "stale", repository: "other/repo", run_id: "124", pr_number: 8, review_id: 71,
    head_ref: "other", head_sha: BASE, base_sha: HEAD, trivial: "true", reason: "too short",
  })) assert.throws(() => validateAssessment({ ...decision(), [field]: value }, snapshot()));
});

test("required checks distinguish pass, pending, failure, skipping, and absent results", () => {
  for (const [bucket, status] of [["pass", 0], ["skipping", 0], ["pending", 8], ["fail", 1], ["cancel", 1]]) {
    const result = readRequiredChecks(snapshot(), {
      run: (command, args) => {
        assert.equal(command, "gh");
        assert.ok(args.includes("--required"));
        assert.equal(args[2], "7");
        assert.ok(args.includes(REPOSITORY));
        return { status, stdout: JSON.stringify([{ name: "Required check", bucket }]), stderr: "" };
      },
    });
    assert.equal(result.failed, ["fail", "cancel"].includes(bucket));
    assert.equal(result.pending, bucket === "pending");
    assert.equal(result.reported, true);
  }
  for (const response of [
    { status: 0, stdout: "[]", stderr: "" },
    { status: 1, stdout: "", stderr: "no required checks reported" },
  ]) {
    const result = readRequiredChecks(snapshot(), { run: () => response });
    assert.equal(result.reported, false);
    assert.equal(result.failed, false);
  }
});

test("missing tools, API errors, malformed check responses, and contradictory results fail visibly", () => {
  for (const response of [
    { error: new Error("gh unavailable") },
    { status: 1, stdout: "", stderr: "API denied" },
    { status: 0, stdout: "not JSON", stderr: "" },
    { status: 0, stdout: "{}", stderr: "" },
    { status: 0, stdout: '[{"name":"","bucket":"pass"}]', stderr: "" },
    { status: 0, stdout: '[{"name":"test","bucket":"unknown"}]', stderr: "" },
    { status: 0, stdout: '[{"name":"test","bucket":"fail"}]', stderr: "" },
    { status: 8, stdout: '[{"name":"test","bucket":"pass"}]', stderr: "" },
    { status: 1, stdout: '[{"name":"test","bucket":"pass"}]', stderr: "" },
  ]) assert.throws(() => readRequiredChecks(snapshot(), { run: () => response }));
});

test("guarded merges pin the analyzed head and verify the confirmed squash merge", async () => {
  const { github, input } = mergeFixture();
  input.event = compactEvent();
  const result = await mergeIfReady(input);
  assert.equal(result.merged, true);
  assert.equal(result.merge_sha, MERGE);
  assert.deepEqual(github.writes(), [{
    route: "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
    parameters: { owner: "example", repo: "project", pull_number: 7, sha: HEAD, merge_method: "squash" },
  }]);
  assert.equal(github.calls.at(-1).route, "GET /repos/{owner}/{repo}/pulls/{pull_number}");
});

test("nontrivial decisions cause no merge readiness reads or writes", async () => {
  const { github, input } = mergeFixture();
  input.decision = decision(false);
  assert.equal((await mergeIfReady(input)).status, "nontrivial");
  assert.deepEqual(github.calls, []);
});

test("stale or foreign decisions never reach merge readiness", async () => {
  for (const mutate of [
    (i) => { i.decision.status = "stale"; },
    (i) => { i.decision.run_id = "124"; },
    (i) => { i.decision.repository = "foreign/repo"; },
    (i) => { i.snapshot.head_sha = BASE; },
    (i) => { i.snapshot.review_id = 71; },
    (i) => { i.decision.trivial = "true"; },
  ]) {
    const { github, input } = mergeFixture();
    mutate(input);
    await assert.rejects(mergeIfReady(input));
    assert.deepEqual(github.calls, []);
  }
});

test("changed PRs, approvals, and base or head revisions prevent merging", async () => {
  for (const mutate of [
    (g) => { g.review.state = "DISMISSED"; },
    (g) => { g.review.commit_id = BASE; },
    (g) => { g.review.id = 71; },
    (g) => { g.pr.state = "closed"; },
    (g) => { g.pr.draft = true; },
    (g) => { g.pr.head.sha = BASE; },
    (g) => { g.pr.base.sha = HEAD; },
    (g) => { g.gate.headRefOid = BASE; },
    (g) => { g.gate.baseRefOid = HEAD; },
    (g) => { g.pr.head.ref = "other"; },
    (g) => { g.pr.head.repo = null; },
    (g) => { g.pr.base.ref = "release"; },
  ]) {
    const { github, input } = mergeFixture();
    mutate(github);
    assert.equal((await mergeIfReady(input)).status, "stale");
    assert.deepEqual(github.writes(), []);
  }
});

test("final revalidation catches changes occurring after the first readiness check", async () => {
  for (const mutate of [
    (g) => { g.review.state = "DISMISSED"; },
    (g) => { g.pr.base.sha = HEAD; g.gate.baseRefOid = HEAD; },
    (g) => { g.pr.head.sha = BASE; g.gate.headRefOid = BASE; },
  ]) {
    const { github, input } = mergeFixture();
    let checks = 0;
    input.readChecks = () => {
      if (++checks === 2) mutate(github);
      return { pending: false, failed: false, reported: true };
    };
    assert.equal((await mergeIfReady(input)).status, "stale");
    assert.deepEqual(github.writes(), []);
  }
});

test("conflicts, requested changes, and failed or cancelled required checks block merging", async () => {
  for (const mutate of [
    (i) => { i.github.gate.mergeable = "CONFLICTING"; },
    (i) => { i.github.gate.reviewDecision = "CHANGES_REQUESTED"; },
    (i) => { i.readChecks = () => ({ failed: true, pending: false, reported: true, reason: "Required checks failed" }); },
  ]) {
    const { github, input } = mergeFixture();
    mutate(input);
    assert.equal((await mergeIfReady(input)).status, "blocked");
    assert.deepEqual(github.writes(), []);
  }
});

test("pending requirements wait within a bound, then expire with a concrete reason", async () => {
  for (const mutate of [
    (i) => { i.readChecks = () => ({ failed: false, pending: true, reported: true, reason: "Waiting for CI" }); },
    (i) => { i.github.gate.reviewDecision = "REVIEW_REQUIRED"; },
    (i) => { i.github.gate.mergeable = "UNKNOWN"; },
    (i) => { i.github.gate.mergeStateStatus = "BLOCKED"; },
    (i) => {
      i.github.gate.mergeStateStatus = "BLOCKED";
      i.readChecks = () => ({ failed: false, pending: false, reported: false, reason: "No results reported" });
    },
  ]) {
    const { github, input } = mergeFixture();
    mutate(input);
    let pauses = 0;
    const progress = [];
    input.pause = () => { pauses++; };
    input.onProgress = (message) => progress.push(message);
    const result = await mergeIfReady(input);
    assert.equal(result.status, "pending-expired");
    assert.equal(pauses, 1);
    assert.equal(progress.length, 2);
    assert.match(result.reason, /Bounded wait expired/);
    assert.deepEqual(github.writes(), []);
  }
});

test("pending required checks can complete without merging a changed revision", async () => {
  const { github, input } = mergeFixture();
  let checks = 0;
  input.readChecks = () => ({ failed: false, pending: ++checks === 1, reported: true, reason: "Waiting for CI" });
  input.pause = () => {};
  assert.equal((await mergeIfReady(input)).merged, true);
  assert.equal(checks, 3);
  assert.equal(github.writes().length, 1);
});

test("repositories with no required checks or review rule can merge only with a clean server gate", async () => {
  const { input } = mergeFixture();
  input.github.gate.reviewDecision = null;
  input.readChecks = () => ({ failed: false, pending: false, reported: false });
  assert.equal((await mergeIfReady(input)).merged, true);
});

test("a final failed check or missing merge metadata cannot authorize a merge", async () => {
  const { github, input } = mergeFixture();
  let checks = 0;
  input.readChecks = () => ({ pending: false, failed: ++checks === 2, reported: true, reason: "Required check failed" });
  assert.equal((await mergeIfReady(input)).status, "blocked");
  assert.deepEqual(github.writes(), []);
  for (const field of ["reviewDecision", "mergeable", "mergeStateStatus"]) {
    const f = mergeFixture();
    delete f.github.gate[field];
    await assert.rejects(mergeIfReady(f.input), /incomplete merge requirements/);
    assert.deepEqual(f.github.writes(), []);
  }
});

test("server protection and head conflicts are reported without retrying or bypassing guards", async () => {
  for (const status of [405, 409]) {
    const { github, input } = mergeFixture();
    github.errors["PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"] = Object.assign(new Error("Merge rejected"), { status });
    const result = await mergeIfReady(input);
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /GitHub rejected/);
    assert.equal(github.writes().length, 1);
  }
});

test("merge API errors, invalid success responses, and unconfirmed merges fail visibly", async () => {
  for (const mutate of [
    (g) => { g.errors["PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"] = new Error("Permission denied"); },
    (g) => { g.mergeResponse = { merged: false, message: "Not merged" }; },
    (g) => { g.mergeResponse.sha = "not-a-sha"; },
    (g) => {
      const request = g.request.bind(g);
      g.request = async (...args) => {
        const response = await request(...args);
        if (args[0].startsWith("PUT ")) g.pr.merge_commit_sha = HEAD;
        return response;
      };
    },
  ]) {
    const { github, input } = mergeFixture();
    mutate(github);
    await assert.rejects(mergeIfReady(input));
    assert.equal(github.writes().some(({ route }) => route.startsWith("DELETE ") || route.startsWith("POST ")), false);
  }
});

test("only the exact confirmed merge can authorize cleanup or evaluation dispatch", async () => {
  for (const mutate of [
    (i) => { i.mergeSha = "invalid"; },
    (i) => { i.github.pr.merged = false; },
    (i) => { i.github.pr.merge_commit_sha = HEAD; },
    (i) => { i.github.pr.head.sha = BASE; },
    (i) => { i.github.pr.head.ref = "other"; },
    (i) => { i.github.pr.base.ref = "release"; },
  ]) {
    const { github, input } = mergedFixture();
    mutate(input);
    await assert.rejects(confirmMerged(input));
    await assert.rejects(deleteSourceBranch(input));
    await assert.rejects(dispatchEvaluation(input));
    assert.deepEqual(github.writes(), []);
  }
});

test("cleanup deletes only the analyzed source ref after confirming the merge", async () => {
  const { github, input } = mergedFixture();
  assert.equal((await deleteSourceBranch(input)).deleted, true);
  assert.deepEqual(github.writes(), [{
    route: "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
    parameters: { owner: "example", repo: "project", ref: "heads/feature/fix" },
  }]);
  assert.equal(github.calls.at(-2).route, "GET /repos/{owner}/{repo}/git/ref/{ref}");
  const query = github.calls.find(({ route }) => route === "GET /repos/{owner}/{repo}/pulls");
  assert.equal(query.parameters.head, "example:feature/fix");
  assert.equal(query.parameters.state, "open");
});

test("cleanup preserves default, protected, shared, advanced, or already deleted branches", async () => {
  for (const [mutate, reason] of [
    [(i) => { i.github.repo.default_branch = "feature/fix"; }, /default branch/],
    [(i) => { i.github.branch.protected = true; }, /protected/],
    [(i) => { i.github.open = [{ number: 8 }]; }, /another open PR/],
    [(i) => { i.github.ref.object.sha = BASE; }, /advanced/],
    [(i) => { i.github.errors["GET /repos/{owner}/{repo}/branches/{branch}"] = Object.assign(new Error("Gone"), { status: 404 }); }, /already deleted/],
  ]) {
    const { github, input } = mergedFixture();
    mutate(input);
    const result = await deleteSourceBranch(input);
    assert.equal(result.deleted, false);
    assert.match(result.reason, reason);
    assert.deepEqual(github.writes(), []);
  }
});

test("cleanup and dispatch permission errors are visible, not success-shaped fallbacks", async () => {
  for (const route of [
    "GET /repos/{owner}/{repo}/branches/{branch}", "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
  ]) {
    const { github, input } = mergedFixture();
    github.errors[route] = Object.assign(new Error("Denied"), { status: 403 });
    await assert.rejects(deleteSourceBranch(input), /Denied/);
  }
  const { github, input } = mergedFixture();
  github.errors["POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"] = new Error("Dispatch denied");
  await assert.rejects(dispatchEvaluation(input), /Dispatch denied/);
});

test("confirmed token merges explicitly dispatch existing evaluation on main", async () => {
  const { github, input } = mergedFixture();
  assert.equal((await dispatchEvaluation(input)).dispatched, true);
  assert.deepEqual(github.writes(), [{
    route: "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
    parameters: { owner: "example", repo: "project", workflow_id: "evaluate.yml", ref: "main" },
  }]);
});

test("merge permissions, checkout, artifacts, and post-merge steps are isolated and run-bound", () => {
  const job = workflow.jobs.merge;
  assert.equal(job.needs, "classify");
  assert.match(job.if, /needs.classify.result == 'success'.*needs.classify.outputs.trivial == 'true'/);
  assert.deepEqual(job.permissions, { contents: "write", "pull-requests": "write", actions: "write" });
  const checkout = job.steps.find((step) => step.uses === "actions/checkout@v7");
  assert.equal(checkout.with.ref, "${{ needs.classify.outputs.base_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const download = job.steps.find((step) => step.uses === "actions/download-artifact@v8");
  assert.equal(download.with.name, "trivial-pr-analysis-${{ github.run_id }}");
  const merge = job.steps.find((step) => step.id === "merge");
  assert.equal(merge.env.GH_TOKEN, "${{ github.token }}");
  assert.match(merge.with.script, /await mergeIfReady/);
  const publication = job.steps.find((step) => step.id === "publication");
  const cleanup = job.steps.find((step) => step.id === "cleanup");
  assert.equal(publication.if, "steps.merge.outputs.merged == 'true'");
  assert.equal(cleanup.if, "always() && steps.merge.outputs.merged == 'true'");
  assert.ok(job.steps.indexOf(publication) < job.steps.indexOf(cleanup));
  assert.equal(cleanup.env.MERGE_SHA, "${{ steps.merge.outputs.merge_sha }}");
});

async function executePreflight(context, payload, pr = event().pull_request, apiError) {
  const directory = mkdtempSync(join(tmpdir(), "trivial-pr-preflight-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputs = {};
  const summaries = [];
  let requests = 0;
  const summary = {
    addHeading(value) { summaries.push(value); return this; },
    addCodeBlock(value) { summaries.push(value); return this; },
    async write() {},
  };
  const script = workflow.jobs.classify.steps.find((step) => step.id === "preflight").with.script;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("require", "process", "context", "github", "core", script)(
    require, { env: { RUNNER_TEMP: directory, GITHUB_REPOSITORY: REPOSITORY } },
    { payload, repo: { owner: "example", repo: "project" } },
    { rest: { pulls: { async get(parameters) {
      requests++;
      assert.equal(parameters.pull_number, payload.pull_request.number);
      if (apiError) throw apiError;
      return { data: clone(pr) };
    } } } },
    { setOutput(name, value) { outputs[name] = value; }, summary },
  );
  const evidence = JSON.parse(readFileSync(join(directory, "trivial-pr-analysis/preflight.json"), "utf8"));
  return { outputs, summaries, evidence, requests };
}

test("preflight reproduces abbreviated approval payloads without silently skipping classification", async (context) => {
  const result = await executePreflight(context, compactEvent());
  assert.equal(result.outputs.ready, "true");
  assert.equal(result.outputs.base_sha, BASE);
  assert.equal(result.requests, 1);
  assert.equal(result.evidence.review_id, 70);
  assert.equal(result.evidence.event_pr_state, undefined);
  assert.ok(result.summaries.some((text) => text.includes("collecting changes")));
});

test("preflight reports non-approving, edited, dismissed, and wrong-target events explicitly", async (context) => {
  for (const payload of [
    { ...event(), action: "edited" }, { ...event(), action: "dismissed" },
    { ...event(), review: { ...event().review, state: "commented" } },
    { ...event(), review: { id: 70 } },
  ]) {
    const result = await executePreflight(context, payload);
    assert.equal(result.outputs.ready, "false");
    assert.equal(result.requests, 0);
    assert.match(result.evidence.reason, /Not a submitted approval/);
    assert.ok(result.summaries.includes("Ineligible review event"));
  }
  const pr = event().pull_request;
  pr.base.ref = "release";
  const result = await executePreflight(context, event(), pr);
  assert.equal(result.outputs.ready, "false");
  assert.match(result.evidence.reason, /does not target/);
});

test("preflight fails visibly for invalid identity, unsafe base revisions, and GitHub errors", async (context) => {
  await assert.rejects(executePreflight(context, { ...event(), review: { ...event().review, id: 0 } }), /Invalid PR or review/);
  const pr = event().pull_request;
  pr.base.sha = "HEAD";
  await assert.rejects(executePreflight(context, event(), pr), /Invalid trusted base/);
  await assert.rejects(executePreflight(context, event(), undefined, new Error("GitHub unavailable")), /GitHub unavailable/);
});

test("workflow scripts round-trip abbreviated approvals through artifacts, classification, merge, and cleanup", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "trivial-pr-pipeline-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidence = join(directory, "temp/trivial-pr-analysis");
  mkdirSync(evidence, { recursive: true });
  const { github } = fixture();
  const outputs = {};
  const summaries = [];
  const summary = {
    addHeading(value) { summaries.push(value); return this; },
    addCodeBlock(value) { summaries.push(value); return this; },
    async write() {},
  };
  const localPath = (value) => isAbsolute(value) ? value : join(directory, value);
  const fs = {
    mkdirSync: (name, options) => mkdirSync(localPath(name), options),
    writeFileSync: (name, content) => writeFileSync(localPath(name), content),
    readFileSync: (name, encoding) => readFileSync(localPath(name), encoding),
  };
  const injected = {
    ...helpers,
    collectSnapshot: (input) => collectSnapshot({ ...input, runGit: collectionGit }),
    classifySnapshot: (input) => classifySnapshot({
      ...input, run: () => ({ status: 0, stdout: JSON.stringify({ trivial: true, reason: REASON }), stderr: "" }),
    }),
    mergeIfReady: (input) => mergeIfReady({ ...input,
      readChecks: () => ({ pending: false, failed: false, reported: true }), attempts: 1,
    }),
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = async (step) => {
    await new AsyncFunction("require", "process", "context", "github", "core", step.with.script)(
      (name) => name === "node:fs" ? fs :
        name.endsWith("/.github/scripts/trivial-pr-automerge.cjs") ? injected : require(name),
      { env: { GITHUB_WORKSPACE: directory, RUNNER_TEMP: join(directory, "temp"),
        GITHUB_REPOSITORY: REPOSITORY, GITHUB_RUN_ID: RUN_ID, MERGE_SHA: outputs.merge_sha } },
      { payload: compactEvent() }, github,
      { setOutput(name, value) { outputs[name] = value; }, summary, info() {} },
    );
  };
  await execute(workflow.jobs.classify.steps.find((step) => step.id === "snapshot"));
  assert.equal(outputs.eligible, "true");
  await execute(workflow.jobs.classify.steps.find((step) => step.id === "classify"));
  assert.equal(outputs.trivial, "true");
  const analyzed = JSON.parse(readFileSync(join(evidence, "snapshot.json"), "utf8"));
  const verdict = JSON.parse(readFileSync(join(evidence, "decision.json"), "utf8"));
  assert.equal(validateAssessment(verdict, analyzed).trivial, true);
  assert.equal(JSON.parse(readFileSync(join(evidence, "copilot-output.txt"), "utf8")).trivial, true);
  cpSync(evidence, join(directory, "out/trivial-pr-automerge"), { recursive: true });
  await execute(workflow.jobs.merge.steps.find((step) => step.id === "merge"));
  assert.equal(outputs.merged, "true");
  assert.equal(outputs.merge_sha, MERGE);
  await execute(workflow.jobs.merge.steps.find((step) => step.id === "publication"));
  await execute(workflow.jobs.merge.steps.find((step) => step.id === "cleanup"));
  for (const [name, field] of [["merge", "merged"], ["publication", "dispatched"], ["cleanup", "deleted"]]) {
    assert.equal(JSON.parse(readFileSync(join(directory, `out/trivial-pr-automerge/${name}.json`), "utf8"))[field], true);
  }
  assert.deepEqual(github.writes().map(({ route }) => route.split(" ")[0]), ["PUT", "POST", "DELETE"]);
  assert.ok(summaries.includes("Squash merge confirmed"));
});
