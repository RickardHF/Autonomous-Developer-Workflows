import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describeArtifact, freshness, isObject, isRunId, validObservation } from "./model.mjs";
import { meta } from "./workflow.mjs";
import { buildPhaseModel } from "./phase-model.mjs";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const isArtifact = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(json|md|patch|txt)$/.test(name) && !name.includes("..");
export class ReadError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function resolveArtifactRoot(cwd = process.cwd()) {
  const { stdout } = await promisify(execFile)("git", ["--no-pager", "rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8" });
  return path.join(await fs.realpath(stdout.trim()), "issue-delivery");
}

export function createStore(root, { now = Date.now, maxFileBytes = MAX_FILE_BYTES } = {}) {
  root = path.resolve(root);
  const verifyRoot = async (create = false) => {
    if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) throw new ReadError("Artifact root is not a canonical directory.", 403);
  };
  const runDirectory = async (runId, create = false) => {
    if (!isRunId(runId)) throw new ReadError("Invalid run identifier.");
    await verifyRoot(create);
    const dir = path.join(root, runId);
    if (create) await fs.mkdir(dir, { mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) throw new ReadError("Run directory must not be a symlink.", 403);
    return dir;
  };
  const readText = async (runId, name) => {
    if (!isArtifact(name)) throw new ReadError("Invalid artifact filename.");
    const dir = await runDirectory(runId);
    const handle = await fs.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ReadError("Artifact is not a regular file.", 403);
      if (stat.size > maxFileBytes) throw new ReadError(`Artifact exceeds the ${maxFileBytes}-byte display limit. Inspect it locally.`, 413);
      // Bound the read even if another writer grows the file after stat().
      const buffer = Buffer.alloc(maxFileBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > maxFileBytes) throw new ReadError("Artifact grew beyond the display limit. Inspect it locally.", 413);
      return buffer.toString("utf8", 0, total);
    } finally { await handle.close(); }
  };
  const readArtifact = async (runId, name) => {
    const text = await readText(runId, name);
    if (!name.endsWith(".json")) return { name, text, kind: name.endsWith(".md") ? "markdown" : "text" };
    let value;
    try { value = JSON.parse(text); }
    catch (error) { return { name, text, kind: "json", view: { title: name, warnings: [`Invalid JSON: ${error.message}`] } }; }
    return { name, text, kind: "json", value, view: describeArtifact(name, value) };
  };
  const getRun = async (runId) => {
    const dir = await runDirectory(runId);
    const warnings = [];
    const artifacts = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!isArtifact(entry.name)) continue;
      if (!entry.isFile()) { warnings.push(`${entry.name}: not a regular file; not exposed.`); continue; }
      try {
        const stat = await fs.lstat(path.join(dir, entry.name));
        if (!stat.isFile()) { warnings.push(`${entry.name}: changed file type; not exposed.`); continue; }
        artifacts.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtimeMs, tooLarge: stat.size > maxFileBytes });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        warnings.push(`${entry.name}: removed during refresh.`);
      }
    }
    artifacts.sort((a, b) => a.name.localeCompare(b.name));
    const metadata = {};
    for (const name of ["dashboard.json", "context.json", "issue.json", "result.json", "plan.json", "implementation.json", "issue-review.json", "quality-security-review.json"]) {
      if (!artifacts.some((artifact) => artifact.name === name)) continue;
      try {
        const artifact = await readArtifact(runId, name);
        warnings.push(...artifact.view.warnings.map((warning) => `${name}: ${warning}`));
        if (isObject(artifact.value)) metadata[name] = artifact.value;
      } catch (error) {
        if (!(error instanceof ReadError) && !["ENOENT", "ELOOP"].includes(error.code)) throw error;
        warnings.push(`${name}: ${error.message}`);
      }
    }
    let observation = metadata["dashboard.json"];
    if (validObservation(observation) && observation.runId !== runId) warnings.push("dashboard.json: run identity does not match its directory.");
    if (!validObservation(observation) || observation.runId !== runId) observation = null;
    const context = metadata["context.json"];
    const issue = metadata["issue.json"];
    const result = metadata["result.json"];
    const modifiedAt = artifacts.length ? Math.max(...artifacts.map((artifact) => artifact.modifiedAt)) : (await fs.stat(dir)).mtimeMs;
    const run = {
      runId, title: typeof issue?.title === "string" ? issue.title : runId,
      issueUrl: typeof issue?.url === "string" ? issue.url : typeof result?.issueUrl === "string" ? result.issueUrl : null,
      branch: typeof context?.branch === "string" ? context.branch : typeof result?.branch === "string" ? result.branch : null,
      recommendation: ["successful", "unsuccessful", "inconclusive"].includes(result?.recommendation) ? result.recommendation : null,
      observation, freshness: freshness(observation, now()), modifiedAt, artifacts, warnings,
    };
    return { ...run, ...buildPhaseModel(run, meta.phases, metadata) };
  };
  return {
    readArtifact, getRun,
    async listRuns() {
      try { await verifyRoot(); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
      const runs = [];
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !isRunId(entry.name)) continue;
        try {
          const { artifacts, observation, phases, runArtifacts, ...run } = await getRun(entry.name);
          runs.push({
            ...run, artifactCount: artifacts.length,
            observation: observation ? { status: observation.status, createdAt: observation.createdAt, observedAt: observation.observedAt } : null,
          });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      return runs.sort((a, b) => (b.observation?.createdAt ?? b.modifiedAt) - (a.observation?.createdAt ?? a.modifiedAt));
    },
    async writeObservation(value) {
      if (!validObservation(value)) throw new Error("Refusing to persist an invalid observation snapshot.");
      try { await runDirectory(value.runId, true); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const dir = await runDirectory(value.runId);
      try {
        const previous = JSON.parse(await readText(value.runId, "dashboard.json"));
        if (!validObservation(previous)) throw new Error("Existing observation snapshot is incompatible; refusing to overwrite it.");
        if (previous.runId !== value.runId) throw new Error("Existing observation snapshot has a different run identity.");
        if (previous.ownerSessionId !== value.ownerSessionId) throw new Error("Observation snapshot belongs to another session.");
        if (previous.revision > value.revision || previous.revision === value.revision && previous.observedAt > value.observedAt) return;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporary = path.join(dir, `.dashboard-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, path.join(dir, "dashboard.json"));
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
  };
}
