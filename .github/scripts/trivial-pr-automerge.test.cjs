const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const helpers = require("./trivial-pr-automerge.cjs");
const {
  LIMITS, eligibility, collectChanges, collectSnapshot, validateSnapshot, validateDecision,
  runCopilot,
} = helpers;

const REPOSITORY = "example/project";
const RUN_ID = "123";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
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

function fakeGithub() {
  const github = {
    calls: [], pr: clone(event().pull_request), review: { id: 70, state: "APPROVED", commit_id: HEAD },
    gate: { headRefOid: HEAD, baseRefOid: BASE, reviewDecision: "APPROVED" },
    writes() { return this.calls.filter(({ route }) => /^(PUT|POST|DELETE) /.test(route)); },
    async request(route, parameters) {
      this.calls.push({ route, parameters: clone(parameters) });
      let data;
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") data = this.pr;
      else if (route.endsWith("/reviews/{review_id}")) data = this.review;
      else throw new Error(`Unexpected API request: ${route}`);
      return { data: clone(data) };
    },
    async graphql(query, parameters) {
      this.calls.push({ route: "GRAPHQL", parameters: clone(parameters) });
      assert.match(query, /headRefOid baseRefOid reviewDecision/);
      return { repository: { pullRequest: clone(this.gate) } };
    },
  };
  return github;
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
  assert.equal(workflow.name, "Classify Approved Trivial PRs");
  assert.deepEqual(workflow.on, { pull_request_review: { types: ["submitted", "edited", "dismissed"] } });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(workflow.concurrency.group, /pull_request.number/);
  assert.deepEqual(Object.keys(workflow.jobs), ["classify"]);
  assert.deepEqual(workflow.jobs.classify.permissions, { contents: "read", "pull-requests": "read", "copilot-requests": "write" });
  assert.match(workflow.jobs.classify.if, /event.action == 'submitted'/);
  assert.match(workflow.jobs.classify.if, /review.state == 'approved'/);
  assert.match(workflow.jobs.classify.if, /base.ref == 'main'/);
  assert.match(workflow.jobs.classify.if, /head.repo.full_name == github.repository/);
  const checkout = workflow.jobs.classify.steps.find((step) => step.uses === "actions/checkout@v7");
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.base.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const cli = workflow.jobs.classify.steps.find((step) => step.id === "classify");
  assert.equal(cli.env.COPILOT_GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(cli.with.script.includes('setOutput("trivial"'), false);
  assert.equal(workflow.jobs.classify.steps.some((step) => /merge|delete|dispatch/i.test(step.name)), false);
  for (const step of workflow.jobs.classify.steps.filter((step) => step.run)) {
    const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const step of workflow.jobs.classify.steps.filter((step) => step.with?.script)) {
    assert.doesNotThrow(() => new (Object.getPrototypeOf(async function () {}).constructor)(step.with.script));
  }
});
