import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";
import { meta, run as originalRun } from "./workflow.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const issueUrl = "https://github.com/RickardHF/Autonomous-Developer-Workflows/issues/42";
const root = "/Users/rickard/repos/private/Autonomous-Developer-Workflows";
const check = { command: "npm test -- feature", outcome: "passed", evidence: "1 test passed" };
const criterion = { id: "AC1", requirement: "The requested behavior works.", verification: "Run the focused behavior test." };
const finding = {
  id: "Q1", severity: "high", category: "security", file: "src/feature.ts",
  startLine: 3, endLine: 4, title: "Unsafe input reaches a query",
  explanation: "User input reaches query construction.", evidence: "request -> query",
  confidence: 9, blocking: true,
};

function harness(options = {}) {
  const files = new Map();
  const journal = new Map();
  const calls = [];
  const prompts = [];
  const logs = [];
  const state = { branch: "shared-branch", head: "a".repeat(40), dirty: options.dirty ?? false, staged: false, text: "implemented" };
  let issueReads = 0;
  let activeReviews = 0;
  let maxActiveReviews = 0;
  const replies = clone({
    "1-plan": {
      status: "ready", goal: "Solve the issue", scope: { included: ["feature"], excluded: ["unrelated"] },
      acceptanceCriteria: [criterion], steps: ["Update feature", "Run focused test"], mitigations: [],
      rollback: "Revert the feature change", validationRequired: true, blockers: [],
    },
    "2-implement": { status: "complete", summary: "Implemented", changes: ["src/feature.ts"], checks: [check], deviations: [], blockers: [] },
    "3-issue-coverage": {
      verdict: "pass", summary: "Behavior meets the issue", coverage: ["src/feature.ts", "src/new.ts"],
      findings: [], checks: [check], criteria: [{ id: "AC1", status: "met", evidence: "Independent check passed" }],
    },
    "4-quality-security": { verdict: "pass", summary: "No concrete defects found", coverage: ["src/feature.ts", "src/new.ts"], findings: [], checks: [], criteria: [] },
    "5-synthesis": { recommendation: "successful", summary: "The issue is solved", rationale: ["Both reviews pass"], findings: [], remainingRisks: [], nextSteps: [] },
    ...clone(options.replies ?? {}),
  });
  const gitOutput = (args) => {
    args = args.slice(1);
    if (args[0] === "symbolic-ref") return state.branch + "\n";
    if (args[0] === "rev-parse") return ({ "--show-toplevel": root, "--absolute-git-dir": root + "/.git" }[args[1]] ?? state.head) + "\n";
    if (args[0] === "status") return state.dirty ? " M src/feature.ts\0?? src/new.ts\0" : "";
    if (args[0] === "ls-files") return state.dirty ? "src/new.ts\0" : "";
    if (args.includes("--cached")) return state.staged ? "staged change" : "";
    if (args.includes("--name-only")) return state.dirty ? "src/feature.ts\0" : "";
    if (args[0] === "diff") return state.dirty ? `diff --git a/src/feature.ts b/src/feature.ts\n+${state.text}\n` : "";
    throw new Error(`Unexpected git command ${args.join(" ")}`);
  };
  const execFile = (program, args, settings, callback) => {
    assert.ok(settings.cwd === root || settings.cwd === "/cwd");
    let output;
    try {
      if (program === "git") output = gitOutput(args);
      else if (program === "gh" && args[0] === "repo") output = JSON.stringify({ nameWithOwner: "RickardHF/Autonomous-Developer-Workflows", url: "https://github.com/RickardHF/Autonomous-Developer-Workflows" });
      else if (program === "gh" && args.at(-1).includes("/comments?")) output = "[[]]";
      else if (program === "gh") {
        issueReads++;
        output = JSON.stringify({
          number: 42, title: "Requested feature", body: options.staleIssue && issueReads > 1 ? "Changed request" : "Implement the feature",
          html_url: issueUrl, updated_at: "2026-10-27T10:00:00Z",
          ...(options.pullRequest ? { pull_request: {} } : {}),
        });
      } else throw new Error(`Unexpected program ${program}`);
      callback(null, output, "");
    } catch (error) {
      callback(error, "", error.message);
    }
  };
  const fs = {
    mkdir: async () => {},
    realpath: async (name) => name,
    writeFile: async (name, value) => files.set(name, Buffer.from(value)),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    readFile: async (name) => {
      if (files.has(name)) return files.get(name);
      if (name === path.join(root, "src/new.ts")) return Buffer.from("new file");
      throw new Error(`Missing file ${name}`);
    },
    lstat: async () => ({ mode: 0o100644, isFile: () => true, isSymbolicLink: () => false }),
    readlink: async () => { throw new Error("Not a symlink"); },
  };
  const modules = { "node:fs/promises": fs, "node:path": path, "node:crypto": crypto, "node:child_process": { execFile } };
  const run = vm.runInNewContext(
    `(${originalRun.toString().replaceAll("await import(", "await load(")})`,
    { load: async (name) => modules[name], process: { env: {}, cwd: () => "/cwd" }, URL, Buffer },
  );
  const ctx = {
    runId: "test-run", args: { issueUrl }, signal: new AbortController().signal,
    phase: () => {}, log: (message) => logs.push(message),
    step: async (key, producer) => {
      if (journal.has(key)) return clone(journal.get(key));
      const result = await producer();
      journal.set(key, clone(result));
      return result;
    },
    parallel: async (thunks) => Promise.all(thunks.map(async (thunk) => {
      try { return await thunk(); } catch (error) { logs.push(error.message); return null; }
    })),
    agent: async (prompt, agentOptions) => {
      const label = agentOptions.label;
      calls.push(label);
      prompts.push({ label, prompt });
      if (label === "2-implement") {
        state.dirty = true;
        if (options.commitDuringImplementation) state.head = "b".repeat(40);
        if (options.stageDuringImplementation) state.staged = true;
      }
      if (label === "3-issue-coverage" || label === "4-quality-security") {
        activeReviews++;
        maxActiveReviews = Math.max(maxActiveReviews, activeReviews);
        await new Promise((resolve) => setImmediate(resolve));
        activeReviews--;
        if (options.mutateDuringReview) state.text = "review changed source";
        if (options.tamperArtifact) {
          const entry = [...files.keys()].find((name) => name.endsWith("/plan.json"));
          files.set(entry, Buffer.from("{}"));
        }
      }
      return clone(replies[label]);
    },
  };
  return {
    ctx, state, files, replies, calls, prompts, logs, journal,
    execute: async () => clone(await run(ctx)),
    get maxActiveReviews() { return maxActiveReviews; },
  };
}

test("metadata declares one required issue URL and the five pipeline phases", () => {
  assert.deepEqual(meta.argsSchema.required, ["issueUrl"]);
  assert.deepEqual(meta.phases.map((phase) => phase.title), ["Prepare", "Plan", "Implement", "Review", "Summarize"]);
  assert.equal(meta.limits, undefined);
});

test("five isolated stages, parallel reviews, new-file coverage, persistent report, same branch", async () => {
  const h = harness();
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.deepEqual(h.calls, ["1-plan", "2-implement", "3-issue-coverage", "4-quality-security", "5-synthesis"]);
  assert.equal(h.maxActiveReviews, 2);
  assert.equal(result.branch, "shared-branch");
  assert.deepEqual(result.changedFiles, ["src/feature.ts", "src/new.ts"]);
  assert.ok([...h.files.keys()].some((name) => name.endsWith("/report.md")));
  const coveragePrompt = h.prompts.find(({ label }) => label === "3-issue-coverage").prompt;
  assert.match(coveragePrompt, /untracked-files\.json/);
  assert.doesNotMatch(coveragePrompt, /quality-security-review\.json/);
  const staticPrompt = h.prompts.find(({ label }) => label === "4-quality-security").prompt;
  assert.match(staticPrompt, /static inspection only/);
  assert.doesNotMatch(staticPrompt, /issue-review\.json/);
});

test("resume reuses successful stages and rejects a different checkout state", async () => {
  const h = harness();
  await h.execute();
  assert.equal((await h.execute()).recommendation, "successful");
  assert.equal(h.calls.length, 5);
  h.state.text = "external edit";
  await assert.rejects(h.execute(), /Checkout changed/);
  assert.equal(h.calls.length, 5);
});

test("dirty checkout and cross-repository issue fail before any agent", async () => {
  const dirty = harness({ dirty: true });
  await assert.rejects(dirty.execute(), /clean checkout/);
  assert.equal(dirty.calls.length, 0);
  const cross = harness();
  cross.ctx.args.issueUrl = "https://github.com/someone/another/issues/42";
  await assert.rejects(cross.execute(), /belong to this checked-out/);
  assert.equal(cross.calls.length, 0);
});

test("invalid URL and PR inputs fail visibly", async () => {
  for (const issueUrl of ["http://github.com/a/b/issues/1", "https://github.com/a/b/pull/1", "https://github.com/a/b/issues/0", "https://github.com/a/b/issues/1?x=y"]) {
    const h = harness();
    h.ctx.args.issueUrl = issueUrl;
    await assert.rejects(h.execute(), /canonical HTTPS/);
    assert.equal(h.calls.length, 0);
  }
  await assert.rejects(harness({ pullRequest: true }).execute(), /pull request/);
});

test("blocked planning preserves blockers without starting implementation", async () => {
  const h = harness();
  h.replies["1-plan"].status = "blocked";
  h.replies["1-plan"].acceptanceCriteria = [];
  h.replies["1-plan"].blockers = ["Need an acceptance decision"];
  const result = await h.execute();
  assert.equal(result.recommendation, "inconclusive");
  assert.deepEqual(result.blockers, ["Need an acceptance decision"]);
  assert.deepEqual(h.calls, ["1-plan"]);
});

test("null planning fails; null implementation cannot become successful", async () => {
  await assert.rejects(harness({ replies: { "1-plan": null } }).execute(), /Planning did not return/);
  const h = harness({ replies: { "2-implement": null } });
  const result = await h.execute();
  assert.equal(result.recommendation, "unsuccessful");
  assert.ok(h.logs.some((message) => message.includes("failed to return output")));
});

test("implementation cannot commit or stage changes", async () => {
  await assert.rejects(harness({ commitDuringImplementation: true }).execute(), /branch, HEAD, or index/);
  await assert.rejects(harness({ stageDuringImplementation: true }).execute(), /branch, HEAD, or index/);
});

test("missing and structurally invalid review cannot count as passing", async () => {
  const missing = harness({ replies: { "4-quality-security": null } });
  assert.equal((await missing.execute()).recommendation, "inconclusive");
  const invalid = harness();
  invalid.replies["3-issue-coverage"].criteria = [];
  assert.equal((await invalid.execute()).recommendation, "inconclusive");
  assert.ok(invalid.logs.some((message) => message.includes("invalid acceptance coverage")));
});

test("read-only review source or artifact tampering halts rather than masking failure", async () => {
  await assert.rejects(harness({ mutateDuringReview: true }).execute(), /Checkout changed/);
  await assert.rejects(harness({ tamperArtifact: true }).execute(), /Handoff artifact changed/);
});

test("high security finding overrides optimistic synthesis and appears in severity table", async () => {
  const h = harness();
  h.replies["4-quality-security"].findings = [finding];
  h.replies["5-synthesis"].findings = [{ source: "quality-security-review", id: "Q1", disposition: "accepted", reason: "Reachable from request input" }];
  const result = await h.execute();
  assert.equal(result.recommendation, "unsuccessful");
  const report = [...h.files.entries()].find(([name]) => name.endsWith("/report.md"))[1].toString();
  assert.match(report, /\u{1F7E0} HIGH/u);
  assert.match(report, /\| # \| Severity \| File \| Lines \| Vulnerability \| Confidence \|/);
});

test("unmet requirement and failed check prevent success", async () => {
  const unmet = harness();
  unmet.replies["3-issue-coverage"].criteria[0].status = "not-met";
  assert.equal((await unmet.execute()).recommendation, "unsuccessful");
  const failed = harness();
  failed.replies["2-implement"].checks[0].outcome = "failed";
  assert.equal((await failed.execute()).recommendation, "unsuccessful");
});

test("unverified acceptance, missing validation, and stale issue remain inconclusive", async () => {
  const unverified = harness();
  unverified.replies["3-issue-coverage"].criteria[0].status = "unverified";
  assert.equal((await unverified.execute()).recommendation, "inconclusive");
  const noChecks = harness();
  noChecks.replies["2-implement"].checks = [];
  assert.equal((await noChecks.execute()).recommendation, "inconclusive");
  assert.equal((await harness({ staleIssue: true }).execute()).recommendation, "inconclusive");
});

test("synthesis must return output and account for every finding", async () => {
  await assert.rejects(harness({ replies: { "5-synthesis": null } }).execute(), /Synthesis did not return/);
  const missing = harness();
  missing.replies["4-quality-security"].findings = [finding];
  await assert.rejects(missing.execute(), /every review finding/);
});

test("source is self-contained and uses no inherited or explicitly overridden model settings", async () => {
  const source = await readFile(new URL("./workflow.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(model|reasoningEffort|contextTier|limits):/);
  assert.equal((source.match(/ctx\.agent\(/g) ?? []).length, 4);
  assert.match(source, /ctx\.parallel\(\[\(\) => review\("issue-review"\), \(\) => review\("quality-security-review"\)\]\)/);
});
