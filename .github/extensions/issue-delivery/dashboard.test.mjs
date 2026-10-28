import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createStore, resolveArtifactRoot } from "./storage.mjs";
import { describeArtifact, freshness, observationFromDetail, validObservation, MAX_PROGRESS, STALE_AFTER_MS } from "./model.mjs";
import { startObserver } from "./observer.mjs";
import { createDashboardCanvas, startDashboardServer } from "./dashboard.mjs";
import * as renderer from "./renderer.mjs";
import { badge, inlineTokens, markdownBlocks, renderArtifact, renderCheckout, renderPatch, safeLink } from "./renderer.mjs";
import { changedFileStatuses, gitPath, parsePatch } from "./diff.mjs";
import { buildPhaseModel } from "./phase-model.mjs";
import { meta } from "./workflow.mjs";

const runId = "test-run";
function detail(overrides = {}) {
  return {
    runId, workflowName: "issue-delivery", revision: 1, status: "running",
    createdAt: 1, updatedAt: 10, observedAt: 10, startedAt: 2, completedAt: null, terminal: null,
    phases: [{ id: "review", title: "Review", status: "active", entryCount: 1, lastEnteredRunAttempt: 1 }],
    agents: [
      { agentId: "a1", phaseId: "review", label: "3-issue-coverage", status: "running", prompt: "must not be persisted" },
      { agentId: "a2", phaseId: "review", label: "4-quality-security", status: "running" },
    ],
    progress: { records: [{ seq: 1, attempt: 1, phaseId: "review", recordedAt: 10, kind: "log", text: "Reviewing" }], hasMoreOlder: false },
    ...overrides,
  };
}
const observation = (overrides = {}, now = 100) => observationFromDetail(detail(overrides), "owner-session", now);
const phaseRun = (overrides = {}) => ({
  artifacts: [], freshness: "recorded",
  observation: observation({
    agents: [],
    phases: meta.phases.map((phase, index) => ({ id: `phase-${index}`, title: phase.title, status: index < 2 ? "completed" : index === 2 ? "active" : "pending" })),
  }),
  ...overrides,
});
const readyPlan = {
  status: "ready", goal: "Solve the issue", scope: { included: ["feature"], excluded: [] },
  acceptanceCriteria: [{ id: "AC1", requirement: "Behavior", verification: "Focused test" }],
  steps: ["Implement"], mitigations: [], rollback: "Revert", validationRequired: true, blockers: [],
};
async function fixture(t, options) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "issue-dashboard-"));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "issue-delivery");
  return {
    root, artifactRoot, store: createStore(artifactRoot, options),
    async write(name, value, id = runId) {
      await fs.mkdir(path.join(artifactRoot, id), { recursive: true });
      await fs.writeFile(path.join(artifactRoot, id, name), typeof value === "string" ? value : JSON.stringify(value));
    },
  };
}
function runtime(overrides = {}) {
  const listeners = new Set();
  const logs = [];
  let current = detail();
  const session = {
    sessionId: "owner-session",
    on(name, callback) {
      assert.equal(name, "workflow.run_updated");
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    log: (message) => logs.push(message),
    workflow: {
      listRuns: async () => ({ runs: [current], omittedOlder: 0 }),
      getRunDetail: async () => current,
      ...overrides,
    },
  };
  return {
    session, logs,
    set: (value) => { current = value; },
    emit: (revision = current.revision) => { for (const listener of listeners) listener({ data: { runId: current.runId, revision } }); },
    get listenerCount() { return listeners.size; },
  };
}

test("known JSON contracts tolerate extra fields and key order, but identify invalid fields", () => {
  assert.deepEqual(describeArtifact("plan.json", { extra: "kept", ...readyPlan }).warnings, []);
  assert.match(describeArtifact("plan.json", { ...readyPlan, steps: null }).warnings.join(), /steps/);
  assert.ok(describeArtifact("future.json", { nested: [1] }).warnings.length);
  assert.ok(describeArtifact("plan.json", []).warnings.length);
});

test("both result variants, unavailable agent output and array manifests are represented honestly", () => {
  assert.deepEqual(describeArtifact("result.json", { recommendation: "inconclusive", stage: "plan", blockers: ["Need input"], artifacts: "/artifacts" }).warnings, []);
  assert.deepEqual(describeArtifact("result.json", {
    recommendation: "unsuccessful", issueUrl: "https://github.com/o/r/issues/1", branch: "main",
    baseSha: "abc", reviewedFingerprint: "123", changedFiles: [], artifacts: "/artifacts",
    gate: {}, synthesis: {}, reviewAvailability: {},
  }).warnings, []);
  assert.match(describeArtifact("issue-review.json", { available: false, output: null }).warnings.join(), /unavailable/);
  assert.match(describeArtifact("implementation.json", { available: true, output: null, changedFiles: [] }).warnings.join(), /null/);
  assert.deepEqual(describeArtifact("untracked-files.json", [{ path: "new.js", mode: 33188, sha256: "abc", symlink: false }]).warnings, []);
  assert.ok(describeArtifact("untracked-files.json", {}).warnings.length);
  const bounded = describeArtifact("untracked-files.json", Array(1_000).fill({}));
  assert.equal(bounded.warnings.length, 401);
  assert.match(bounded.warnings.at(-1), /limited/);
});

test("observation snapshots exclude prompts and bound progress with explicit truncation", () => {
  const records = Array.from({ length: MAX_PROGRESS + 1 }, (_, seq) => ({ seq, text: "x".repeat(4_001), attempt: 1 }));
  const value = observation({ progress: { records } });
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.progress.records.length, MAX_PROGRESS);
  assert.equal(value.progress.records[0].text.length, 4_000);
  assert.equal(value.progress.truncated, true);
  assert.equal(JSON.stringify(value).includes("must not be persisted"), false);
  assert.equal(value.agents.length, 2);
  assert.equal(validObservation({ ...value, schemaVersion: 999 }), false);
  assert.equal(validObservation({ ...value, phases: [null] }), false);
});

test("stale live observations are not converted into invented terminal states", () => {
  const value = observation();
  assert.equal(freshness(null), "artifact-only");
  assert.equal(freshness(value, 101), "recorded");
  assert.equal(freshness(value, 100 + STALE_AFTER_MS + 1), "stale");
  assert.equal(value.status, "running");
  assert.equal(freshness(observation({ status: "completed" }), 100 + STALE_AFTER_MS + 1), "recorded");
  assert.equal(freshness(observation({ status: "paused" }), 100 + STALE_AFTER_MS + 1), "recorded");
  assert.match(observation({ terminal: { failure: { type: "workflow_limit_reached", kind: "timeoutSeconds", value: 10 } } }).error, /workflow_limit_reached/);
});

test("phase order and dependency path come from the workflow definition", () => {
  const { phases } = buildPhaseModel(phaseRun(), meta.phases);
  assert.deepEqual(phases.map((phase) => phase.title), meta.phases.map((phase) => phase.title));
  assert.deepEqual(phases.map((phase) => phase.dependsOn), [[], ["prepare"], ["plan"], ["implement"], ["review"]]);
  assert.deepEqual(phases.map((phase) => [phase.state, phase.color]), [
    ["completed", "green"], ["completed", "green"], ["active", "blue"], ["pending", "gray"], ["pending", "gray"],
  ]);
  const reversed = buildPhaseModel(phaseRun(), [...meta.phases].reverse()).phases;
  assert.equal(reversed[0].title, "Summarize");
  assert.deepEqual(reversed[1].dependsOn, ["summarize"]);
});

test("every known artifact belongs to its producing phase; future files stay inspectable", async (t) => {
  const f = await fixture(t);
  const expected = [
    ["issue.json", "context.json"], ["plan.json"],
    ["implementation.json", "changes.patch"],
    ["issue-review.json", "quality-security-review.json"],
    ["report.md", "result.json", "summary.json", "decision-gate.json"],
  ];
  for (const name of [...expected.flat(), "future.json", "dashboard.json", "untracked-files.json", "review-snapshot.json"]) await f.write(name, "{}");
  const run = await f.store.getRun(runId);
  assert.deepEqual(run.phases.map((phase) => phase.artifacts.map((entry) => entry.name)), expected);
  assert.deepEqual(run.runArtifacts.map((entry) => entry.name), ["dashboard.json", "future.json", "untracked-files.json"]);
  assert.equal(run.phases[2].checkout.name, "review-snapshot.json");
  assert.equal(run.phases[2].artifacts[1].format, "Patch");
  assert.equal(run.phases[4].artifacts[0].format, "Markdown");
  assert.equal(run.phases[1].artifacts[0].label, "Implementation plan");
  const listed = (await f.store.listRuns())[0];
  assert.equal(listed.phases, undefined);
  assert.equal(listed.runArtifacts, undefined);
});

test("historical artifacts never invent phase completion", () => {
  const run = phaseRun({ observation: null, freshness: "artifact-only", artifacts: [{ name: "result.json" }, { name: "plan.json" }] });
  assert.ok(buildPhaseModel(run, meta.phases).phases.every((phase) => phase.state === "unknown" && phase.color === "gray"));
});

test("blocked planning results stay with Plan, and removed phases cannot hide artifacts", () => {
  const run = phaseRun({ artifacts: [{ name: "result.json" }, { name: "report.md" }] });
  const metadata = { "result.json": { stage: "plan", recommendation: "inconclusive" } };
  const { phases } = buildPhaseModel(run, meta.phases, metadata);
  assert.deepEqual(phases[1].artifacts.map((entry) => entry.name), ["result.json"]);
  assert.deepEqual(phases[4].artifacts.map((entry) => entry.name), ["report.md"]);
  const changedDefinition = buildPhaseModel(run, [meta.phases[0]], metadata);
  assert.deepEqual(changedDefinition.runArtifacts.map((entry) => entry.name), ["result.json", "report.md"]);
});

test("current failed phase is red while earlier completed and future phases keep their state", () => {
  const run = phaseRun();
  run.observation.status = "error";
  run.observation.error = "Source fingerprint changed.";
  run.observation.currentPhaseId = "phase-2";
  const phases = buildPhaseModel(run, meta.phases).phases;
  assert.equal(phases[2].color, "red");
  assert.match(phases[2].reason, /fingerprint/);
  assert.equal(phases[1].color, "green");
  assert.equal(phases[3].color, "gray");
});

test("paused, halted, cancelled and prematurely closed phases are yellow, not completed", () => {
  for (const status of ["paused", "halted", "cancelled", "completed"]) {
    const run = phaseRun();
    run.observation.status = status;
    assert.equal(buildPhaseModel(run, meta.phases).phases[2].color, "yellow", status);
    assert.equal(buildPhaseModel(run, meta.phases).phases[1].color, "green", status);
  }
  const run = phaseRun();
  run.observation.status = "paused";
  run.observation.phases[2].status = "completed";
  assert.equal(buildPhaseModel(run, meta.phases).phases[2].state, "completed");
});

test("blocked planning and unavailable or malformed agent output are closed unfinished", () => {
  const run = phaseRun();
  run.observation.phases[2].status = "completed";
  for (const value of [{ available: false, output: null }, { available: true, output: null }, { available: true, output: "invalid" }, { available: true, output: [] }]) {
    const phase = buildPhaseModel(run, meta.phases, { "implementation.json": value }).phases[2];
    assert.equal(phase.color, "yellow");
  }
  assert.equal(buildPhaseModel(phaseRun(), meta.phases, { "plan.json": { status: "blocked" } }).phases[1].state, "closed");
});

test("failed validation and failing review verdicts mark their phase red", () => {
  const run = phaseRun();
  run.observation.phases[2].status = "completed";
  run.observation.phases[3].status = "completed";
  const phases = buildPhaseModel(run, meta.phases, {
    "implementation.json": { available: true, output: { checks: [{ outcome: "failed" }] } },
    "issue-review.json": { available: true, output: { verdict: "fail" } },
  }).phases;
  assert.equal(phases[2].color, "red");
  assert.equal(phases[3].color, "red");
});

test("resumed active phases do not inherit failures or incomplete files from a previous attempt", () => {
  for (const value of [
    { available: false, output: null },
    { available: true, output: { status: "blocked", checks: [{ outcome: "failed" }] } },
  ]) {
    assert.equal(buildPhaseModel(phaseRun(), meta.phases, { "implementation.json": value }).phases[2].state, "active");
  }
});

test("stale active phases become explicitly unknown, skipped phases remain gray", () => {
  const run = phaseRun({ freshness: "stale" });
  run.observation.phases[4].status = "skipped";
  const phases = buildPhaseModel(run, meta.phases).phases;
  assert.equal(phases[2].state, "unknown");
  assert.match(phases[2].reason, /stale/);
  assert.equal(phases[4].state, "skipped");
  assert.equal(phases[4].color, "gray");
});

test("resumed phases use the latest agent per branch, retaining both parallel reviewers", () => {
  const run = phaseRun();
  run.observation.phases[2].status = "completed";
  run.observation.phases[3].status = "active";
  run.observation.agents = [
    { agentId: "old", phaseId: "phase-3", label: "3-issue-coverage", status: "failed", startedAt: 1 },
    { agentId: "new", phaseId: "phase-3", label: "3-issue-coverage", status: "running", startedAt: 20 },
    { agentId: "parallel", phaseId: "phase-3", label: "4-quality-security", status: "completed", startedAt: 15 },
  ];
  const phase = buildPhaseModel(run, meta.phases).phases[3];
  assert.equal(phase.state, "active");
  assert.deepEqual(phase.agents.map((agent) => agent.agentId), ["new", "parallel"]);
  run.observation.agents[1].status = "error";
  assert.equal(buildPhaseModel(run, meta.phases).phases[3].color, "red");
  run.observation.agents[1].status = "halted";
  assert.equal(buildPhaseModel(run, meta.phases).phases[3].color, "yellow");
});

test("malformed evidence cannot crash phase classification and current-phase snapshots remain compatible", () => {
  for (const value of [null, [], "invalid", { output: { checks: "invalid" } }, { checks: [null, "invalid"] }]) {
    assert.doesNotThrow(() => buildPhaseModel(phaseRun(), meta.phases, { "implementation.json": value }));
  }
  const current = observation({ currentPhase: { id: "review" } });
  assert.equal(current.currentPhaseId, "review");
  assert.equal(validObservation(current), true);
  delete current.currentPhaseId;
  assert.equal(validObservation(current), true);
  assert.equal(validObservation({ ...current, currentPhaseId: 42 }), false);
});

test("status badges consistently expose the five semantic colors without relying on color alone", () => {
  const doc = { createElement: (tag) => ({ tag, dataset: {} }) };
  for (const [status, color] of [["Completed", "green"], ["Not started", "gray"], ["Skipped", "gray"], ["Error", "red"], ["In progress", "blue"], ["Closed unfinished", "yellow"]]) {
    const node = badge(doc, status);
    assert.equal(node.dataset.color, color);
    assert.equal(node.textContent, status);
  }
});

test("first-run missing storage is empty; permission/type failures are not empty success", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.listRuns(), []);
  await fs.writeFile(f.artifactRoot, "not a directory");
  await assert.rejects(f.store.listRuns(), /canonical directory/);
});

test("historical, empty, malformed and future-version runs remain inspectable", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.artifactRoot, "empty-run"), { recursive: true });
  await f.write("plan.json", readyPlan);
  await f.write("result.json", { recommendation: "inconclusive", stage: "plan", blockers: ["Need input"], artifacts: "/x" });
  await f.write("dashboard.json", { schemaVersion: 2, status: "running" });
  await f.write("issue.json", "{ broken");
  await f.write(".dashboard-leftover.tmp", "private temporary data");
  const run = await f.store.getRun(runId);
  assert.equal(run.freshness, "artifact-only");
  assert.equal(run.observation, null);
  assert.equal(run.recommendation, "inconclusive");
  assert.equal(run.artifacts.some((entry) => entry.name.startsWith(".")), false);
  assert.match(run.warnings.join(), /Invalid JSON/);
  assert.match(run.warnings.join(), /Unsupported/);
  const artifact = await f.store.readArtifact(runId, "issue.json");
  assert.equal(artifact.text, "{ broken");
  assert.equal(Object.hasOwn(artifact, "value"), false);
  const runs = await f.store.listRuns();
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.runId === "empty-run").artifactCount, 0);
});

test("runtime status and delivery recommendation remain separate across sessions", async (t) => {
  const f = await fixture(t);
  await f.store.writeObservation(observation({ status: "completed" }));
  await f.write("result.json", { recommendation: "unsuccessful", stage: "plan", blockers: ["Blocked"], artifacts: "/x" });
  const otherSessionStore = createStore(f.artifactRoot);
  const run = await otherSessionStore.getRun(runId);
  assert.equal(run.observation.status, "completed");
  assert.equal(run.recommendation, "unsuccessful");
  assert.equal(run.observation.ownerSessionId, "owner-session");
  assert.equal((await otherSessionStore.listRuns())[0].observation.progress, undefined);
});

test("observation writes are private, atomic, monotonic and leave handoff files untouched", async (t) => {
  const f = await fixture(t);
  await f.write("plan.json", readyPlan);
  const before = await fs.readFile(path.join(f.artifactRoot, runId, "plan.json"), "utf8");
  await f.store.writeObservation(observation({ revision: 2 }));
  await f.store.writeObservation(observation({ revision: 1 }, 200));
  assert.equal((await f.store.getRun(runId)).observation.revision, 2);
  await f.store.writeObservation(observation({ revision: 2 }, 300));
  assert.equal((await f.store.getRun(runId)).observation.observedAt, 300);
  const snapshotPath = path.join(f.artifactRoot, runId, "dashboard.json");
  assert.equal((await fs.stat(snapshotPath)).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(path.dirname(snapshotPath))).some((name) => name.endsWith(".tmp")), false);
  assert.equal(await fs.readFile(path.join(f.artifactRoot, runId, "plan.json"), "utf8"), before);
  await assert.rejects(f.store.writeObservation({ ...observation(), ownerSessionId: "different" }), /another session/);
});

test("mismatched and incompatible snapshots are visible but never trusted or overwritten", async (t) => {
  const f = await fixture(t);
  await f.write("dashboard.json", observation({ runId: "different-run" }));
  const run = await f.store.getRun(runId);
  assert.equal(run.observation, null);
  assert.match(run.warnings.join(), /identity/);
  await assert.rejects(f.store.writeObservation(observation()), /different run identity/);
  await f.write("dashboard.json", { schemaVersion: 999 });
  await assert.rejects(f.store.writeObservation(observation()), /incompatible/);
});

test("traversal, symlink files/directories and oversized reads are rejected", async (t) => {
  const f = await fixture(t, { maxFileBytes: 32 });
  await f.write("report.md", "ok");
  await f.write("large.txt", "x".repeat(33));
  await fs.writeFile(path.join(f.root, "outside.txt"), "outside");
  await fs.symlink(path.join(f.root, "outside.txt"), path.join(f.artifactRoot, runId, "link.txt"));
  await fs.symlink(path.join(f.artifactRoot, runId), path.join(f.artifactRoot, "linked-run"));
  await assert.rejects(f.store.readArtifact("../", "report.md"), /identifier/);
  await assert.rejects(f.store.readArtifact(runId, "../../outside.txt"), /filename/);
  await assert.rejects(f.store.readArtifact(runId, "link.txt"));
  await assert.rejects(f.store.readArtifact("linked-run", "report.md"), /symlink/);
  await assert.rejects(f.store.readArtifact(runId, "large.txt"), (error) => error.status === 413);
  const run = await f.store.getRun(runId);
  assert.equal(run.artifacts.some((entry) => entry.name === "link.txt"), false);
  assert.equal(run.artifacts.find((entry) => entry.name === "large.txt").tooLarge, true);
  assert.equal((await f.store.listRuns()).length, 1);
});

test("observer records initial/terminal/resumed state and same-revision live heartbeat", async (t) => {
  const f = await fixture(t);
  const r = runtime();
  let now = 100;
  const observer = startObserver(r.session, f.store, { now: () => now, intervalMs: 60_000 });
  t.after(() => observer.close());
  await observer.ready;
  assert.equal((await f.store.getRun(runId)).observation.observedAt, 100);
  now = 200;
  await observer.refresh();
  assert.equal((await f.store.getRun(runId)).observation.observedAt, 200);
  r.set(detail({ revision: 2, status: "completed", completedAt: 190 }));
  r.emit();
  await observer.refresh();
  assert.equal((await f.store.getRun(runId)).observation.status, "completed");
  r.set(detail({ revision: 3, status: "running" }));
  r.emit();
  await observer.refresh();
  assert.equal((await f.store.getRun(runId)).observation.status, "running");
  await observer.close();
  assert.equal(r.listenerCount, 0);
});

test("observer paginates history, filters other workflows and handles missed invalidations", async (t) => {
  const f = await fixture(t);
  const calls = [];
  let missed = false;
  const r = runtime({
    listRuns: async (options) => {
      calls.push(options.beforeSeq);
      return options.beforeSeq === undefined
        ? { runs: [detail({ revision: missed ? 2 : 1 }), detail({ runId: "other", workflowName: "other" })], omittedOlder: 1, oldestSeq: 20 }
        : { runs: [detail({ runId: "older-run", status: "completed" })], omittedOlder: 0, oldestSeq: 10 };
    },
    getRunDetail: async (id) => detail({ runId: id, revision: missed ? 2 : 1 }),
  });
  const observer = startObserver(r.session, f.store, { intervalMs: 60_000 });
  t.after(() => observer.close());
  await observer.ready;
  assert.deepEqual(calls, [undefined, 20]);
  assert.equal((await f.store.listRuns()).length, 2);
  missed = true;
  await observer.refresh();
  assert.equal((await f.store.getRun(runId)).observation.revision, 2);
});

test("duplicate/out-of-order notifications never regress persisted progress", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const r = runtime({ getRunDetail: async () => { reads++; return detail({ revision: 4, status: "completed" }); } });
  r.set(detail({ revision: 4, status: "completed" }));
  const observer = startObserver(r.session, f.store, { intervalMs: 60_000 });
  t.after(() => observer.close());
  await observer.ready;
  for (const revision of [4, 3, 1, 4]) r.emit(revision);
  await observer.refresh();
  assert.equal(reads, 1);
  assert.equal((await f.store.getRun(runId)).observation.revision, 4);
});

test("observation failures are logged and surfaced, not silently reported as no runs", async (t) => {
  const r = runtime({ listRuns: async () => { throw new Error("storage unavailable"); } });
  const writes = [];
  const observer = startObserver(r.session, { writeObservation: async (value) => writes.push(value) }, { intervalMs: 60_000 });
  t.after(() => observer.close());
  await observer.ready;
  assert.match(observer.health().errors[0].message, /storage unavailable/);
  assert.match(r.logs.join(), /storage unavailable/);
  assert.equal(writes.length, 0);
});

test("observer records failed-before-artifacts runs and surfaces write failures", async (t) => {
  const f = await fixture(t);
  const r = runtime();
  r.set(detail({ status: "error", terminal: { error: "Clean checkout required" } }));
  const observer = startObserver(r.session, f.store, { intervalMs: 60_000 });
  t.after(() => observer.close());
  await observer.ready;
  const run = await f.store.getRun(runId);
  assert.equal(run.observation.status, "error");
  assert.equal(run.observation.error, "Clean checkout required");
  assert.deepEqual(run.artifacts.map((entry) => entry.name), ["dashboard.json"]);
  const failed = startObserver(r.session, { writeObservation: async () => { throw new Error("disk full"); } }, { intervalMs: 60_000 });
  t.after(() => failed.close());
  await failed.ready;
  assert.match(failed.health().errors[0].message, /disk full/);
});

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.once("error", reject);
    req.end();
  });
}

test("loopback server serves assets and read-only APIs behind a private capability", async (t) => {
  const f = await fixture(t);
  await f.write("report.md", "# Captured report");
  const server = await startDashboardServer(f.store);
  t.after(() => server.close());
  assert.equal(new URL(server.url).hostname, "127.0.0.1");
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await page.text(), /Issue delivery runs/);
  for (const asset of ["dashboard.js", "dashboard.css", "renderer.mjs", "diff.mjs"]) assert.equal((await fetch(new URL(asset, server.url))).status, 200);
  const result = await (await fetch(new URL("api/runs", server.url))).json();
  assert.equal(result.runs[0].runId, runId);
  assert.equal((await fetch(new URL(`api/artifact?runId=${runId}&name=report.md`, server.url))).status, 200);
  assert.equal((await fetch(new URL("/", server.url))).status, 404);
  assert.equal((await fetch(new URL("api/run?runId=missing", server.url))).status, 404);
  assert.equal((await fetch(new URL("api/runs", server.url), { method: "POST" })).status, 405);
  assert.equal((await fetch(new URL("api/runs", server.url), { headers: { Origin: "https://outside.example" } })).status, 403);
  assert.equal(await rawRequest(new URL("api/runs", server.url), { Host: "outside.example" }), 403);
  assert.equal(await rawRequest(new URL("api/runs", server.url), { "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal((await fetch(new URL("api/artifact?runId=..&name=config", server.url))).status, 400);
});

test("server surfaces storage errors instead of a success-shaped empty response", async (t) => {
  const errors = [];
  const server = await startDashboardServer({ listRuns: async () => { throw new Error("Cannot read storage"); } }, { reportError: (error) => errors.push(error.message) });
  t.after(() => server.close());
  const response = await fetch(new URL("api/runs", server.url));
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Cannot read storage/);
  assert.deepEqual(errors, ["Cannot read storage"]);
});

test("canvas reopening is idempotent and all actions are observational", async (t) => {
  const f = await fixture(t);
  const dashboard = createDashboardCanvas((options) => options, f.store);
  t.after(() => dashboard.close());
  assert.equal(dashboard.canvas.id, "issue-delivery-runs");
  assert.deepEqual(dashboard.canvas.actions.map((action) => action.name), ["list_runs"]);
  const [first, second] = await Promise.all([
    dashboard.canvas.open({ instanceId: "panel-1" }), dashboard.canvas.open({ instanceId: "panel-1" }),
  ]);
  assert.equal(first.url, second.url);
  assert.deepEqual(await dashboard.canvas.actions[0].handler(), []);
  await dashboard.canvas.onClose({ instanceId: "panel-1" });
  await assert.rejects(fetch(first.url));
  const reopened = await dashboard.canvas.open({ instanceId: "panel-1" });
  assert.notEqual(reopened.url, first.url);
});

test("safe Markdown supports report tables, code, lists and links without HTML execution", () => {
  const blocks = markdownBlocks("# Report\n\n| File | Finding |\n|---|---|\n| a\\|b | **Problem** |\n\n```js\n<script>alert(1)</script>\n```\n\n- item\n- next\n\n1. first\n2. second");
  assert.deepEqual(blocks.map((block) => block.type), ["h1", "table", "code", "ul", "ol"]);
  assert.equal(blocks[1].rows[0][0], "a|b");
  assert.match(blocks[2].text, /<script>/);
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("data:text/html,test"), null);
  assert.equal(safeLink("https://user:pass@example.com"), null);
  assert.equal(safeLink("https://github.com/o/r/issues/1"), "https://github.com/o/r/issues/1");
  assert.equal(inlineTokens("[unsafe](javascript:alert)")[0].href, null);
  assert.equal(inlineTokens("<img src=x onerror=alert(1)>")[0].type, "text");
});

test("entrypoint preserves workflow registration and contributes no mutation tools", async () => {
  const source = await fs.readFile(new URL("extension.mjs", import.meta.url), "utf8");
  assert.match(source, /workflows: \[defineWorkflow\(\{ meta, run \}\)\]/);
  assert.match(source, /canvases: \[dashboard.canvas\]/);
  assert.doesNotMatch(source, /onPermissionRequest|requestedEnvironmentVariables|tools:/);
  assert.equal(path.basename(await resolveArtifactRoot()), "issue-delivery");
});

test("entrypoint joins with both contributions and cleans up observer and canvases", async (t) => {
  const f = await fixture(t);
  const r = runtime({ listRuns: async () => ({ runs: [] }) });
  let joined;
  const signals = new Map();
  const source = (await fs.readFile(new URL("extension.mjs", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
  await vm.runInNewContext(`(async () => { ${source} })()`, {
    createCanvas: (options) => options, defineWorkflow: (options) => options,
    joinSession: async (options) => { joined = options; return r.session; },
    createStore, resolveArtifactRoot: async () => f.artifactRoot, startObserver,
    logError: async () => {}, createDashboardCanvas, meta: { name: "issue-delivery" }, run: async () => {},
    process: { once: (signal, callback) => signals.set(signal, callback), exit: () => {} },
  });
  assert.equal(joined.workflows[0].meta.name, "issue-delivery");
  assert.equal(joined.canvases[0].id, "issue-delivery-runs");
  const panel = await joined.canvases[0].open({ instanceId: "wired-panel" });
  assert.equal((await fetch(panel.url)).status, 200);
  assert.equal(r.listenerCount, 1);
  await joined.hooks.onSessionEnd();
  await joined.hooks.onSessionEnd();
  assert.equal(r.listenerCount, 0);
  assert.equal(signals.size, 2);
  await assert.rejects(fetch(panel.url));
});

// Only the DOM surface used by the renderer/client; no parser or browser dependency.
class TestNode {
  constructor(tag, doc, text = "") {
    this.tagName = tag;
    this.ownerDocument = doc;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.className = "";
    this._text = text;
    this.classList = { add: (...names) => { this.className = [this.className, ...names].filter(Boolean).join(" "); } };
  }
  get children() { return this.childNodes.filter((node) => node.tagName !== "#text"); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get textContent() { return this._text + this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...nodes) {
    for (let node of nodes) {
      if (!(node instanceof TestNode)) node = this.ownerDocument.createTextNode(String(node));
      if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      this.childNodes.push(node); node.parentNode = this;
    }
  }
  prepend(...nodes) {
    const previous = [...this.childNodes]; this.replaceChildren(...nodes, ...previous);
  }
  replaceChildren(...nodes) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = []; this._text = ""; this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "class") this.className = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback); this.listeners.set(name, listeners);
  }
  dispatch(name, event = {}) { for (const callback of this.listeners.get(name) ?? []) callback({ target: this, ...event }); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1)) : node.tagName === selector;
    return this.children.flatMap((node) => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
function testDocument() {
  const doc = {
    createElement: (tag) => new TestNode(tag, doc),
    createElementNS: (_, tag) => new TestNode(tag, doc),
    createTextNode: (text) => new TestNode("#text", doc, text),
  };
  doc.body = doc.createElement("body");
  return doc;
}

const patch = [
  "diff --git a/src/feature.ts b/src/feature.ts", "index abc..def 100644",
  "--- a/src/feature.ts", "+++ b/src/feature.ts", "@@ -4,2 +4,3 @@ function feature()",
  " context", "-old", "+new", "+extra", "\\ No newline at end of file",
  "diff --git a/removed.ts b/removed.ts", "deleted file mode 100644",
  "--- a/removed.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone", "",
].join("\n");
const finding = {
  id: "Q1", title: "Concrete defect", severity: "high", category: "code-quality",
  file: "src/feature.ts", startLine: 4, endLine: 5, explanation: "**Observed** consequence",
  evidence: "Call path uses `old` state", confidence: 9, blocking: true,
};
const reviewOutput = {
  verdict: "fail", summary: "Review **failed**", coverage: ["Checked the input boundary"],
  findings: [finding], checks: [{ command: "node --test", outcome: "failed", evidence: "Expected 2, got 1" }],
  criteria: [{ id: "AC1", status: "not-met", evidence: "Behavior is missing" }],
};
const implementationOutput = {
  status: "complete", summary: "Implemented **behavior**", changes: ["Added the feature"],
  checks: [{ command: "node --test", outcome: "passed", evidence: "1 test passed" }],
  deviations: ["Used the existing helper"], blockers: [],
};
const synthesis = {
  recommendation: "unsuccessful", summary: "Review requires a fix", rationale: ["Concrete defect"],
  findings: [{ source: "quality-security-review", id: "Q1", disposition: "accepted", reason: "Reproduced from the call path" }],
  remainingRisks: ["Input path remains affected"], nextSteps: ["Fix Q1"],
};

test("captured issue and individual comments render headings, safe links, dates and Markdown", () => {
  const doc = testDocument();
  const node = renderArtifact(doc, "issue.json", {
    number: 42, title: "Better reports", url: "https://github.com/o/r/issues/42",
    updatedAt: "2026-10-28T12:00:00Z", body: "# Details\n\n**Important** and `code`\n\n<script>no()</script>",
    comments: [
      { id: 8, url: "https://github.com/o/r/issues/42#issuecomment-8", updated_at: "2026-10-28T13:00:00Z", body: "*First* comment" },
      { id: 9, url: "javascript:alert(1)", updated_at: "bad", body: null },
    ],
  });
  assert.equal(node.querySelector("h3").textContent, "#42 Better reports");
  const articles = node.querySelectorAll("article");
  assert.equal(articles.length, 3);
  assert.equal(articles[0].children[1].href, "https://github.com/o/r/issues/42");
  assert.equal(articles[0].firstChild.lastChild.tagName, "time");
  assert.equal(articles[0].querySelector("time").dateTime, "2026-10-28T12:00:00Z");
  assert.equal(articles[1].querySelector("h3").textContent, "Comment 8");
  assert.equal(articles[1].querySelector("time").dateTime, "2026-10-28T13:00:00Z");
  assert.equal(articles[2].querySelector("a"), null);
  assert.match(articles[2].textContent, /No body provided/);
  assert.equal(node.querySelectorAll("strong").length, 1);
  assert.equal(node.querySelectorAll("em").length, 1);
  assert.equal(node.querySelector("script"), null);
  assert.match(node.textContent, /<script>no/);
  assert.equal(node.querySelector("dl"), null);
});

test("plan uses a top badge, titled sections and the exact acceptance-criteria table", () => {
  const node = renderArtifact(testDocument(), "plan.json", { ...readyPlan, future: "retained in Raw" });
  assert.equal(node.firstChild.textContent, "ready");
  assert.deepEqual(node.querySelectorAll("h3").map((node) => node.textContent),
    ["Goal", "Scope", "Included", "Excluded", "Acceptance Criteria", "Steps", "Mitigations", "Rollback", "Validation Required", "Blockers"]);
  assert.deepEqual(node.querySelectorAll("th").map((node) => node.textContent), ["ID", "Requirements", "Verification"]);
  assert.deepEqual(node.querySelectorAll("td").map((node) => node.textContent), ["AC1", "Behavior", "Focused test"]);
  assert.ok(node.querySelectorAll("th").every((node) => node.scope === "col"));
  assert.match(node.textContent, /Additional properties are available in Raw/);
  assert.equal(node.querySelector("dl"), null);
});

test("implementation renders status-colored files before a property-heading-free report", () => {
  const node = renderArtifact(testDocument(), "implementation.json", {
    available: true, output: implementationOutput, changedFiles: ["src/feature.ts", "removed.ts", "new.ts"],
  }, { patch, manifest: [{ path: "new.ts" }] });
  assert.equal(node.firstChild.className, "changed-files");
  assert.deepEqual(node.querySelectorAll(".changed-file").map((node) => [node.firstChild.textContent, node.dataset.change, node.lastChild.textContent]), [
    ["src/feature.ts", "modified", "Modified"], ["removed.ts", "deleted", "Deleted"], ["new.ts", "added", "Added"],
  ]);
  const report = node.querySelector(".output-report");
  assert.equal(report.querySelector("h3"), null);
  assert.equal(report.querySelector("dl"), null);
  assert.equal(report.firstChild.textContent, "complete");
  assert.match(report.textContent, /Implemented behavior/);
  assert.match(report.textContent, /Used the existing helper/);
  assert.match(report.textContent, /1 test passed/);
  assert.match(node.textContent, /contents were not captured/);
});

test("both reviewers show output alone with finding details and no wrapper/property headings", () => {
  for (const name of ["issue-review.json", "quality-security-review.json"]) {
    const node = renderArtifact(testDocument(), name, { available: true, output: reviewOutput });
    assert.equal(node.querySelector("h3"), null);
    assert.equal(node.querySelector("dl"), null);
    assert.match(node.textContent, /Concrete defect/);
    assert.match(node.textContent, /src\/feature.ts:4-5/);
    assert.match(node.textContent, /9\/10/);
    assert.match(node.textContent, /Call path uses old state/);
    assert.match(node.textContent, /Yes/);
    assert.equal(node.querySelector(".badge").textContent, "fail");
    const unavailable = renderArtifact(testDocument(), name, { available: false, output: null });
    assert.match(unavailable.textContent, /not a passing result/);
    assert.equal(unavailable.querySelector(".badge"), null);
  }
});

test("synthesis and both final-result variants use titled sections and disposition tables", () => {
  const result = {
    recommendation: "unsuccessful", issueUrl: "https://github.com/o/r/issues/42", branch: "main", baseSha: "abc",
    reviewedFingerprint: "123", changedFiles: ["src/feature.ts"], artifacts: "/recorded",
    gate: { maximumRecommendation: "unsuccessful", failures: ["Q1"], uncertainties: [] },
    synthesis, reviewAvailability: { issue: true, qualitySecurity: false },
  };
  for (const [name, value] of [["summary.json", synthesis], ["result.json", result]]) {
    const node = renderArtifact(testDocument(), name, value);
    assert.equal(node.querySelector("dl"), null);
    assert.deepEqual(node.querySelectorAll("th").map((node) => node.textContent), ["Source", "ID", "Disposition", "Reason"]);
    assert.deepEqual(node.querySelectorAll("td").map((node) => node.textContent),
      ["quality-security-review", "Q1", "accepted", "Reproduced from the call path"]);
    assert.ok(node.querySelectorAll("h3").some((node) => node.textContent === "Findings"));
  }
  const node = renderArtifact(testDocument(), "result.json", result);
  assert.deepEqual(node.children.slice(0, 3).map((node) => node.firstChild.textContent), ["Recommendation", "Synthesis", "Gate"]);
  const availability = node.querySelectorAll("section").find((node) => node.firstChild.textContent === "Review Availability");
  assert.match(availability.textContent, /IssueYesQuality SecurityNo/);
  const blocked = renderArtifact(testDocument(), "result.json", { stage: "plan", recommendation: "inconclusive", blockers: ["Need a decision"], artifacts: "/recorded" });
  assert.match(blocked.textContent, /BlockersNeed a decision/);
  assert.equal(blocked.querySelector("dl"), null);
});

test("checkout strip omits property labels and duplicate changed files but preserves exact Raw", () => {
  const value = { branch: "main", head: "abc123", fingerprint: "hash", note: "Recorded before review", changedFiles: ["hidden.ts"] };
  const raw = JSON.stringify(value, null, 2);
  const node = renderCheckout(testDocument(), value, raw);
  const identity = node.querySelector(".checkout-identity");
  assert.equal(identity.textContent, "mainabc123hash");
  assert.equal(identity.querySelector("dl"), null);
  assert.equal(identity.textContent.includes("hidden.ts"), false);
  assert.equal(node.querySelector("pre").textContent, raw);
  assert.equal(identity.querySelector("code").getAttribute("aria-label"), "Reviewed revision: abc123");
});

test("unified diff renders accurate line numbers, context, deletions and additions", () => {
  const parsed = parsePatch(patch);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.files.map((file) => [file.path, file.status]), [["src/feature.ts", "modified"], ["removed.ts", "deleted"]]);
  assert.deepEqual(parsed.files[0].lines.filter((line) => ["context", "deleted", "added"].includes(line.type)).map((line) => [line.type, line.old, line.next]),
    [["context", 4, 4], ["deleted", 5, null], ["added", null, 5], ["added", null, 6]]);
  const node = renderPatch(testDocument(), patch);
  assert.equal(node.querySelectorAll(".diff-file").length, 2);
  const removed = node.querySelectorAll("tr").find((row) => row.dataset.change === "deleted");
  assert.deepEqual(removed.children.map((node) => node.textContent), ["5", "", "-", "old"]);
  const added = node.querySelectorAll("tr").find((row) => row.dataset.change === "added");
  assert.deepEqual(added.children.map((node) => node.textContent), ["", "5", "+", "new"]);
  assert.match(node.textContent, /No newline at end of file/);
});

test("Git diff metadata handles added, renamed, copied, binary, mode-only and quoted UTF-8 paths", () => {
  const source = [
    'diff --git "a/\\303\\245 name.ts" "b/\\303\\245 name.ts"', "new file mode 100644",
    "--- /dev/null", '+++ "b/\\303\\245 name.ts"', "@@ -0,0 +1 @@", "+hello",
    "diff --git a/old name.ts b/new name.ts", "similarity index 100%", "rename from old name.ts", "rename to new name.ts",
    "diff --git a/source.ts b/copy.ts", "copy from source.ts", "copy to copy.ts",
    "diff --git a/mode.ts b/mode.ts", "old mode 100644", "new mode 100755",
    "diff --git a/file.bin b/file.bin", "GIT binary patch", "literal 4", "Xabc", "",
  ].join("\n");
  const parsed = parsePatch(source);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.files.map((file) => [file.path, file.status]), [
    ["å name.ts", "added"], ["new name.ts", "renamed"], ["copy.ts", "copied"], ["mode.ts", "modified"], ["file.bin", "modified"],
  ]);
  assert.equal(parsed.files.at(-1).binary, true);
  assert.match(renderPatch(testDocument(), source).textContent, /Binary content changed/);
  assert.equal(gitPath('"a\\\\b\\t\\042.ts"'), 'a\\b\t".ts');
  assert.equal(parsePatch("diff --git a/a b/a\n@@ -1,2 +1 @@\n-old\n+new\n").error, "Incomplete unified diff hunk.");
  assert.equal(parsePatch("diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n+extra\n").error, "Diff lines exceed the recorded hunk range.");
  assert.match(renderPatch(testDocument(), "unsupported patch").textContent, /Cannot preview this patch/);
  assert.match(renderPatch(testDocument(), "").textContent, /No tracked-file changes/);
  assert.deepEqual(changedFileStatuses(["unknown.ts"], null, null), [{ path: "unknown.ts", status: "unclassified" }]);
  assert.equal(changedFileStatuses(["src/feature.ts"], "invalid", null)[0].status, "unclassified");
  assert.deepEqual(changedFileStatuses(["new name.ts"], source, []).filter((entry) => entry.status === "renamed"),
    [{ path: "new name.ts", status: "renamed" }]);
});

test("real Git patches preserve spaces, quoted paths, UTF-8 bytes and path separators", async (t) => {
  const f = await fixture(t);
  const names = ["space name.ts", "å.ts", "dir b/name.ts", "tab\tname.ts", 'quote"name.ts'];
  const git = (...args) => execFileSync("git", args, { cwd: f.root, encoding: "utf8", env: { ...process.env, GIT_PAGER: "cat" } });
  git("init", "--quiet");
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(f.root, name)), { recursive: true });
    await fs.writeFile(path.join(f.root, name), "before\n");
  }
  git("add", "--", ...names);
  for (const name of names) await fs.writeFile(path.join(f.root, name), "after\n");
  const result = parsePatch(git("-c", "core.quotePath=true", "diff", "--binary", "--no-ext-diff"));
  assert.equal(result.error, null);
  assert.deepEqual(result.files.map((file) => file.path).sort(), [...names].sort());
  assert.ok(result.files.every((file) => file.status === "modified"));
  assert.ok(result.files.every((file) => file.lines.some((line) => line.type === "added" && line.text === "after" && line.next === 1)));
});

test("preview budgets bound cumulative Markdown, comment counts, rows and patch lines", () => {
  const doc = testDocument();
  const issue = renderArtifact(doc, "issue.json", {
    number: 1, title: "Large", body: "x".repeat(90_000), comments: Array.from({ length: 1_000 }, (_, id) => ({ id, body: "y".repeat(10_000) })),
  });
  assert.equal(issue.querySelectorAll("article").length, 101);
  assert.match(issue.textContent, /Rendered preview limited/);
  assert.ok(issue.textContent.length < 120_000);
  const plan = renderArtifact(doc, "plan.json", { ...readyPlan, acceptanceCriteria: Array(1_000).fill(readyPlan.acceptanceCriteria[0]) });
  assert.equal(plan.querySelectorAll("td").length, 300);
  assert.match(plan.textContent, /Rendered preview limited/);
  const source = `diff --git a/a b/a\n@@ -1,9000 +1,9000 @@\n${" context\n".repeat(9_000)}`;
  assert.equal(parsePatch(source).limited, true);
  assert.match(renderPatch(doc, source).textContent, /Diff preview limited/);
  for (const value of [null, [], "bad", { comments: [null] }, { output: "bad" }]) {
    for (const name of ["issue.json", "plan.json", "implementation.json", "result.json"]) assert.doesNotThrow(() => renderArtifact(doc, name, value));
  }
});

async function dashboardClient(t, records, runIds = ["client-run"]) {
  const doc = testDocument();
  const html = await fs.readFile(new URL("dashboard.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, doc.createElement("div")]));
  for (const [id, node] of nodes) { node.id = id; doc.body.append(node); }
  doc.getElementById = (id) => nodes.get(id);
  const calls = [];
  const waits = new Map();
  let interval;
  const run = (id) => {
    const artifacts = [...records].map(([name, value]) => ({ name, size: value.text.length, modifiedAt: value.version ?? 1 }));
    return {
      runId: id, title: id, branch: "main", freshness: "artifact-only", observation: null, recommendation: null,
      warnings: [], artifacts, ...buildPhaseModel({ artifacts, observation: null, freshness: "artifact-only" }, meta.phases),
    };
  };
  const source = (await fs.readFile(new URL("dashboard.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
  const client = {
    document: doc, nodes, calls, waits,
    async settle() { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)); },
    async phase(name) {
      nodes.get("phases").querySelectorAll("button").find((node) => node.dataset.phaseKey === name).dispatch("click");
      await this.settle();
    },
    async refresh() { interval(); await this.settle(); },
    async selectRun(id) { nodes.get("run-picker").dispatch("change", { target: { value: id } }); await this.settle(); },
  };
  vm.runInNewContext(source, {
    ...renderer, document: doc, location: { href: "http://127.0.0.1/panel/" }, URL, AbortSignal,
    setInterval: (callback) => { interval = callback; return 1; }, clearInterval: () => {},
    window: { addEventListener: () => {} },
    fetch: async (url) => {
      const route = url.pathname.split("/").at(-1); calls.push([route, url.searchParams.get("name")]);
      if (route === "runs") return { ok: true, json: async () => ({ runs: runIds.map(run), observer: { errors: [] } }) };
      if (route === "run") return { ok: true, json: async () => run(url.searchParams.get("runId")) };
      const name = url.searchParams.get("name");
      if (waits.has(name)) await waits.get(name);
      const record = records.get(name);
      if (record.error) throw new Error(record.error);
      let value;
      try { value = JSON.parse(record.text); } catch { /* Patch fixtures are plain text. */ }
      return { ok: true, json: async () => ({ name, text: record.text, kind: name.endsWith(".json") ? "json" : "text",
        ...(value !== undefined ? { value, view: { warnings: [] } } : {}) }) };
    },
  });
  t.after(() => { interval = () => {}; });
  await client.settle();
  return client;
}

const clientRecords = () => new Map([
  ["implementation.json", { text: JSON.stringify({ available: true, output: implementationOutput, changedFiles: ["src/feature.ts", "removed.ts", "new.ts"] }) }],
  ["changes.patch", { text: patch }],
  ["untracked-files.json", { text: JSON.stringify([{ path: "new.ts", mode: 33188, sha256: "abc", symlink: false }]) }],
  ["review-snapshot.json", { text: JSON.stringify({ branch: "main", head: "abc", fingerprint: "hash", changedFiles: ["new.ts"], note: "Tracked patch only" }) }],
]);

test("dashboard places checkout above artifacts, relocates manifest, and preserves exact Raw toggles", async (t) => {
  const client = await dashboardClient(t, clientRecords());
  const { nodes } = client;
  assert.equal(nodes.get("checkout").hidden, false);
  assert.match(nodes.get("checkout").textContent, /mainabchash/);
  const artifacts = nodes.get("phase-artifacts");
  assert.deepEqual(artifacts.children.map((node) => node.dataset.artifact), ["implementation.json", "changes.patch"]);
  assert.deepEqual(nodes.get("run-artifacts").children.map((node) => node.dataset.artifact), ["untracked-files.json"]);
  const panel = artifacts.firstChild;
  const raw = panel.querySelectorAll("button").find((node) => node.textContent === "Raw");
  raw.dispatch("click");
  assert.equal(panel.querySelector("pre").textContent, clientRecords().get("implementation.json").text);
  await client.refresh();
  assert.equal(raw.getAttribute("aria-pressed"), "true");
  assert.equal(panel.open, true);
  await client.phase("prepare");
  assert.equal(nodes.get("checkout").hidden, true);
  await client.phase("implement");
  assert.equal(nodes.get("checkout").hidden, false);
  assert.equal(raw.getAttribute("aria-pressed"), "true");
  const html = await fs.readFile(new URL("dashboard.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="checkout"') < html.indexOf('id="phase-artifacts"'));
});

test("dependent patch and manifest updates refresh the implementation even when its JSON is unchanged", async (t) => {
  const records = clientRecords();
  const client = await dashboardClient(t, records);
  const panel = client.nodes.get("phase-artifacts").firstChild;
  const original = panel.querySelector(".output-report");
  await client.refresh();
  assert.equal(panel.querySelector(".output-report"), original);
  assert.equal(client.calls.filter(([route, name]) => route === "artifact" && name === "implementation.json").length, 1);
  records.set("untracked-files.json", { text: "[]", version: 2 });
  await client.refresh();
  assert.equal(panel.querySelectorAll(".changed-file").find((node) => node.firstChild.textContent === "new.ts").dataset.change, "unclassified");
  records.set("changes.patch", { text: patch.replace("deleted file mode", "new file mode"), version: 2 });
  await client.refresh();
  assert.equal(panel.querySelectorAll(".changed-file").find((node) => node.firstChild.textContent === "removed.ts").dataset.change, "added");
  assert.equal(client.calls.filter(([route, name]) => route === "artifact" && name === "implementation.json").length, 1);
});

test("related-artifact failures keep the main output visible and can be retried", async (t) => {
  const records = clientRecords();
  records.get("untracked-files.json").error = "Read denied";
  const client = await dashboardClient(t, records);
  const panel = client.nodes.get("phase-artifacts").firstChild;
  assert.match(panel.textContent, /Cannot load untracked-files.json: Read denied/);
  assert.match(panel.textContent, /Implemented behavior/);
  delete records.get("untracked-files.json").error;
  await client.refresh();
  assert.doesNotMatch(panel.textContent, /Read denied/);
  assert.equal(panel.querySelectorAll(".changed-file").find((node) => node.firstChild.textContent === "new.ts").dataset.change, "added");
});

test("slow artifact responses cannot overwrite a newly selected run", async (t) => {
  const client = await dashboardClient(t, clientRecords(), ["first", "second"]);
  let release;
  client.waits.set("implementation.json", new Promise((resolve) => { release = resolve; }));
  await client.selectRun("second");
  await client.selectRun("first");
  assert.equal(client.nodes.get("phase-artifacts").firstChild.querySelector(".output-report"), null);
  release();
  await client.settle();
  assert.match(client.nodes.get("overview").textContent, /first/);
  assert.match(client.nodes.get("phase-artifacts").textContent, /Implemented behavior/);
});
