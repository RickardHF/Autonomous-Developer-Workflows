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
  runCopilot, readRequiredChecks, mergeIfReady, deleteSourceBranch, dispatchEvaluation,
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

function fakeGithub() {
  const github = {
    calls: [], pr: clone(event().pull_request), review: { id: 70, state: "APPROVED", commit_id: HEAD },
    gate: { headRefOid: HEAD, baseRefOid: BASE, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
    defaultBranch: "main", protected: false, branchSha: HEAD, branchMissing: false, shared: [],
    beforeRequest: null, beforeGraph: null,
    writes() { return this.calls.filter(({ route }) => /^(PUT|POST|DELETE) /.test(route)); },
    async request(route, parameters) {
      this.calls.push({ route, parameters: clone(parameters) });
      if (this.beforeRequest) await this.beforeRequest(route, parameters);
      let data;
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") data = this.pr;
      else if (route.endsWith("/reviews/{review_id}")) data = this.review;
      else if (route === "GET /repos/{owner}/{repo}") data = { default_branch: this.defaultBranch };
      else if (route === "GET /repos/{owner}/{repo}/branches/{branch}") {
        if (this.branchMissing) throw Object.assign(new Error("Not found"), { status: 404 });
        data = { protected: this.protected, commit: { sha: this.branchSha } };
      } else if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") data = this.refData || { object: { sha: this.branchSha, type: "commit" } };
      else if (route === "GET /repos/{owner}/{repo}/pulls") data = this.shared;
      else if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") {
        assert.equal(parameters.sha, this.pr.head.sha);
        assert.equal(parameters.merge_method, "squash");
        this.pr.merged = true;
        this.pr.state = "closed";
        this.pr.merge_commit_sha = MERGE;
        data = { merged: true, sha: MERGE };
      } else if (route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}") {
        this.branchMissing = true;
        data = {};
      } else if (route === "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches") data = {};
      else throw new Error(`Unexpected API request: ${route}`);
      return { data: clone(data) };
    },
    async graphql(query, parameters) {
      this.calls.push({ route: "GRAPHQL", parameters: clone(parameters) });
      assert.match(query, /reviewDecision mergeable mergeStateStatus/);
      if (this.beforeGraph) await this.beforeGraph();
      return { repository: { pullRequest: clone(this.gate) } };
    },
    async paginate(route, parameters) { return (await this.request(route, parameters)).data; },
  };
  return github;
}

function fixture() {
  const github = fakeGithub();
  const input = { github, event: event(), repository: REPOSITORY, runId: RUN_ID, snapshot: snapshot() };
  return {
    github, input,
    merge: (overrides = {}) => mergeIfReady({
      ...input, decision: { trivial: true, reason: REASON }, attempts: 2,
      readChecks: () => ({ pending: false, failed: false, reason: "Required checks passed" }),
      pause: async () => {}, ...overrides,
    }),
    postMerge: () => ({ ...input, mergeSha: MERGE }),
  };
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
  assert.match(collectChanges({ cwd: f.directory, baseSha: f.base, headSha: automationHead }).reason, /require manual merging/);
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

test("required-check responses distinguish passing, pending, missing, failed, cancelled, and API errors", () => {
  const checks = (status, values, stderr = "") => readRequiredChecks(snapshot(), {
    run: (command, args) => {
      assert.equal(command, "gh");
      assert.ok(args.includes("--required"));
      return { status, stdout: values === null ? "" : JSON.stringify(values), stderr };
    },
  });
  assert.equal(checks(0, [{ name: "gate", bucket: "pass" }]).pending, false);
  assert.equal(checks(0, [{ name: "gate", bucket: "skipping" }]).failed, false);
  assert.equal(checks(8, [{ name: "gate", bucket: "pending" }]).pending, true);
  assert.equal(checks(1, null, "no required checks reported on the branch").pending, true);
  assert.equal(checks(0, []).pending, true);
  assert.equal(checks(1, [{ name: "gate", bucket: "fail" }]).failed, true);
  assert.equal(checks(1, [{ name: "gate", bucket: "cancel" }]).failed, true);
  assert.throws(() => checks(1, null, "HTTP 403: forbidden"), /Could not read required checks.*403/);
  assert.throws(() => checks(2, []), /Could not read required checks/);
  assert.throws(() => checks(0, [{ name: "gate", bucket: "unknown" }]), /Invalid required-check/);
  assert.throws(() => checks(1, [{ name: "gate", bucket: "pass" }], "API failure"), /exit status contradicts/);
});

test("nontrivial, uncertain, invalid, or stale decisions never mutate GitHub", async () => {
  const f = fixture();
  assert.equal((await f.merge({ decision: { trivial: false, reason: REASON } })).merged, false);
  assert.deepEqual(f.github.calls, []);
  await assert.rejects(f.merge({ decision: { trivial: "true", reason: REASON } }), /Copilot must return exactly/);
  await assert.rejects(f.merge({ snapshot: { ...f.input.snapshot, run_id: "untrusted" } }), /snapshot does not match/);
  assert.deepEqual(f.github.writes(), []);
  for (const mutate of [
    (g) => { g.pr.head.sha = BASE; }, (g) => { g.pr.base.sha = HEAD; },
    (g) => { g.pr.head.ref = "renamed"; }, (g) => { g.pr.base.ref = "release"; },
    (g) => { g.pr.draft = true; }, (g) => { g.pr.state = "closed"; },
    (g) => { g.pr.merged = true; }, (g) => { g.review.state = "DISMISSED"; },
    (g) => { g.review.commit_id = BASE; }, (g) => { g.gate.reviewDecision = "CHANGES_REQUESTED"; },
    (g) => { g.gate.reviewDecision = "REVIEW_REQUIRED"; }, (g) => { g.gate.headRefOid = BASE; },
    (g) => { g.gate.mergeable = "CONFLICTING"; },
  ]) {
    const other = fixture();
    mutate(other.github);
    assert.equal((await other.merge()).merged, false);
    assert.deepEqual(other.github.writes(), []);
  }
});

test("pending checks can pass, and squash merging is pinned to the analyzed head", async () => {
  const f = fixture();
  let reads = 0;
  let pauses = 0;
  const result = await f.merge({
    readChecks: () => ({ pending: reads++ === 0, failed: false, reason: "Required gate pending" }),
    pause: async () => { pauses++; },
  });
  assert.equal(result.merged, true);
  assert.equal(result.merge_sha, MERGE);
  assert.equal(pauses, 1);
  assert.equal(reads, 3);
  assert.deepEqual(f.github.writes().map(({ parameters }) => parameters), [
    { owner: "example", repo: "project", pull_number: 7, sha: HEAD, merge_method: "squash" },
  ]);
  assert.equal((await f.merge()).merged, false);
  assert.equal(f.github.writes().length, 1);
});

test("failed checks, bounded waits, and blocked or unknown merge requirements cannot merge", async () => {
  const failed = fixture();
  assert.equal((await failed.merge({ readChecks: () => ({ pending: false, failed: true, reason: "Regression failed" }) })).reason, "Regression failed");
  assert.deepEqual(failed.github.writes(), []);
  for (const status of ["BLOCKED", "UNKNOWN", "BEHIND"]) {
    const f = fixture();
    f.github.gate.mergeStateStatus = status;
    assert.match((await f.merge()).reason, /Bounded wait expired/);
    assert.deepEqual(f.github.writes(), []);
  }
  const pending = fixture();
  let pauses = 0;
  assert.match((await pending.merge({
    readChecks: () => ({ pending: true, failed: false, reason: "pending" }),
    pause: async () => { pauses++; },
  })).reason, /Bounded wait expired/);
  assert.equal(pauses, 1);
  assert.deepEqual(pending.github.writes(), []);
});

test("state and checks are rechecked immediately before mutation", async () => {
  for (const mutate of [
    (g) => { g.pr.head.sha = BASE; }, (g) => { g.pr.base.sha = HEAD; },
    (g) => { g.review.state = "DISMISSED"; }, (g) => { g.gate.reviewDecision = "CHANGES_REQUESTED"; },
  ]) {
    const f = fixture();
    const result = await f.merge({
      readChecks: () => {
        mutate(f.github);
        return { pending: false, failed: false, reason: "checks passed before PR changed" };
      },
    });
    assert.equal(result.merged, false);
    assert.deepEqual(f.github.writes(), []);
  }
  const f = fixture();
  let reads = 0;
  const result = await f.merge({
    readChecks: () => ({ pending: false, failed: ++reads === 2, reason: "Regression failed on recheck" }),
  });
  assert.equal(result.merged, false);
  assert.deepEqual(f.github.writes(), []);
});

test("GitHub API errors and merge refusals remain explicit failures", async () => {
  const f = fixture();
  f.github.beforeRequest = (route) => {
    if (route.startsWith("PUT")) throw Object.assign(new Error("Branch rules refused merge"), { status: 405 });
  };
  await assert.rejects(f.merge(), /Branch rules refused merge/);
  assert.equal(f.github.pr.merged, undefined);
  await assert.rejects(deleteSourceBranch(f.postMerge()), /does not confirm/);
  await assert.rejects(dispatchEvaluation(f.postMerge()), /does not confirm/);
  assert.ok(!f.github.calls.some(({ route }) => /^(DELETE|POST) /.test(route)));
  const inaccessible = fixture();
  inaccessible.github.beforeRequest = () => { throw new Error("Permission denied"); };
  await assert.rejects(inaccessible.merge(), /Permission denied/);
  assert.deepEqual(inaccessible.github.writes(), []);
});

test("a success-status API response without affirmative merge confirmation cannot authorize cleanup or dispatch", async () => {
  const f = fixture();
  const request = f.github.request.bind(f.github);
  f.github.request = (route, parameters) => {
    if (route.startsWith("PUT")) return { data: { merged: false, message: "Required conditions not satisfied" } };
    return request(route, parameters);
  };
  await assert.rejects(f.merge(), /did not confirm merge success.*Required conditions/);
  await assert.rejects(deleteSourceBranch(f.postMerge()), /does not confirm/);
  await assert.rejects(dispatchEvaluation(f.postMerge()), /does not confirm/);
  assert.deepEqual(f.github.writes(), []);
});

test("branch deletion and evaluation dispatch require confirmed merge identity", async () => {
  const f = fixture();
  await f.merge();
  assert.equal((await deleteSourceBranch(f.postMerge())).deleted, true);
  assert.deepEqual(f.github.writes().at(-1), {
    route: "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
    parameters: { owner: "example", repo: "project", ref: "heads/feature/fix" },
  });
  assert.match((await deleteSourceBranch(f.postMerge())).reason, /already deleted/);
  assert.equal((await dispatchEvaluation(f.postMerge())).dispatched, true);
  assert.deepEqual(f.github.writes().at(-1), {
    route: "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
    parameters: { owner: "example", repo: "project", workflow_id: "evaluate.yml", ref: "main" },
  });
  await assert.rejects(dispatchEvaluation({ ...f.postMerge(), mergeSha: HEAD }), /does not confirm/);
});

test("advanced, protected, shared, and default source branches are retained", async () => {
  for (const mutate of [
    (g) => { g.branchSha = BASE; }, (g) => { g.protected = true; },
    (g) => { g.shared = [{ number: 9 }]; }, (g) => { g.defaultBranch = "feature/fix"; },
  ]) {
    const f = fixture();
    await f.merge();
    mutate(f.github);
    assert.equal((await deleteSourceBranch(f.postMerge())).deleted, false);
    assert.ok(!f.github.writes().some(({ route }) => route.startsWith("DELETE")));
    assert.equal((await dispatchEvaluation(f.postMerge())).dispatched, true);
  }
});

test("concurrent branch deletion is reported but unexpected cleanup and dispatch errors fail explicitly", async () => {
  const f = fixture();
  await f.merge();
  f.github.beforeRequest = (route) => {
    if (route.includes("/git/ref/")) throw Object.assign(new Error("Already deleted"), { status: 404 });
  };
  assert.match((await deleteSourceBranch(f.postMerge())).reason, /deleted concurrently/);
  f.github.beforeRequest = (route) => {
    if (route.includes("/branches/")) throw Object.assign(new Error("Forbidden"), { status: 403 });
  };
  await assert.rejects(deleteSourceBranch(f.postMerge()), /Forbidden/);
  f.github.beforeRequest = (route) => {
    if (route.includes("/dispatches")) throw new Error("Evaluation dispatch unavailable");
  };
  await assert.rejects(dispatchEvaluation(f.postMerge()), /Evaluation dispatch unavailable/);
  f.github.beforeRequest = null;
  f.github.refData = {};
  await assert.rejects(deleteSourceBranch(f.postMerge()), /Invalid source branch reference/);
  assert.ok(!f.github.writes().some(({ route }) => route.startsWith("DELETE")));
});
const repository = resolve(__dirname, "../..");
const { parseDocument } = createRequire(join(repository, "evaluator/package.json"))("yaml");
const document = parseDocument(readFileSync(join(repository, ".github/workflows/trivial-pr-automerge.yml"), "utf8"));
assert.deepEqual(document.errors, []);
const workflow = document.toJS();
const mergeSteps = workflow.jobs.merge.steps;

test("workflow permissions, review gating, trusted checkouts, and non-cancelling concurrency are correct", () => {
  assert.deepEqual(workflow.on, { pull_request_review: { types: ["submitted", "edited", "dismissed"] } });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(workflow.concurrency.group, /pull_request.number/);
  assert.deepEqual(workflow.jobs.classify.permissions, { contents: "read", "pull-requests": "read", "copilot-requests": "write" });
  assert.deepEqual(workflow.jobs.merge.permissions, { contents: "write", "pull-requests": "write", checks: "read", actions: "write" });
  assert.match(workflow.jobs.classify.if, /event.action == 'submitted'/);
  assert.match(workflow.jobs.classify.if, /review.state == 'approved'/);
  assert.match(workflow.jobs.classify.if, /base.ref == 'main'/);
  assert.match(workflow.jobs.classify.if, /head.repo.full_name == github.repository/);
  assert.equal(workflow.jobs.merge.needs, "classify");
  assert.match(workflow.jobs.merge.if, /result == 'success'.*outputs.trivial == 'true'/);
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find((step) => step.uses === "actions/checkout@v7");
    assert.equal(checkout.with.ref, "${{ github.event.pull_request.base.sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
  }
  const cli = workflow.jobs.classify.steps.find((step) => step.id === "classify");
  assert.equal(cli.env.COPILOT_GITHUB_TOKEN, "${{ github.token }}");
  for (const step of mergeSteps.filter((step) => ["cleanup", "evaluation"].includes(step.id))) {
    assert.equal(step.if, "always() && steps.merge.outputs.merged == 'true'");
  }
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

test("actual post-merge workflow scripts still dispatch evaluation when branch cleanup fails", async (context) => {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "trivial-pr-workflow-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "out/trivial-pr-automerge"), { recursive: true });
  writeFileSync(join(directory, "out/trivial-pr-automerge/snapshot.json"), JSON.stringify(f.input.snapshot));
  writeFileSync(join(directory, "out/trivial-pr-automerge/decision.json"), JSON.stringify({ trivial: true, reason: REASON }));
  const fs = {
    readFileSync: (file, ...args) => readFileSync(join(directory, file), ...args),
    writeFileSync: (file, ...args) => writeFileSync(join(directory, file), ...args),
    mkdirSync: (file, ...args) => mkdirSync(join(directory, file), ...args),
  };
  const outputs = {};
  const core = {
    setOutput: (name, value) => { outputs[name] = value; }, info: () => {}, warning: () => {},
    summary: { addHeading() { return this; }, addCodeBlock() { return this; }, async write() {} },
  };
  const env = { GITHUB_WORKSPACE: repository, GITHUB_REPOSITORY: REPOSITORY, GITHUB_RUN_ID: RUN_ID, MERGE_SHA: MERGE };
  const customRequire = (name) => {
    if (name === "node:fs") return fs;
    if (name.endsWith("trivial-pr-automerge.cjs")) return {
      ...helpers,
      mergeIfReady: (input) => f.merge(input),
    };
    return require(name);
  };
  const run = (id) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const script = mergeSteps.find((step) => step.id === id).with.script;
    return new AsyncFunction("require", "github", "context", "core", "process", script)(
      customRequire, f.github, { payload: f.input.event }, core, { env },
    );
  };
  await run("merge");
  assert.equal(outputs.merged, "true");
  assert.equal(outputs.merge_sha, MERGE);
  f.github.beforeRequest = (route) => {
    if (route.startsWith("DELETE")) throw new Error("Branch cleanup API unavailable");
  };
  await assert.rejects(run("cleanup"), /Branch cleanup API unavailable/);
  await run("evaluation");
  assert.equal(JSON.parse(readFileSync(join(directory, "out/trivial-pr-results/merge.json"), "utf8")).merged, true);
  assert.equal(JSON.parse(readFileSync(join(directory, "out/trivial-pr-results/evaluation.json"), "utf8")).dispatched, true);
  assert.ok(f.github.writes().some(({ route }) => route.includes("/dispatches")));
});
