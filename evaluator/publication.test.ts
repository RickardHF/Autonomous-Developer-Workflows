import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { generateBadgeSvg } from "./badge.js";
import {
    createSnapshot, newerSnapshot, stagePages, validateSnapshot, writeSnapshot,
    type EvaluationSnapshot,
} from "./publication.js";

const evaluatorDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = "example/workshop";
const pagesUrl = "https://example.github.io/workshop/";
const agent = ".github/agents/example.agent.md";
const skill = ".agents/skills/example/SKILL.md";
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function git(directory: string, ...args: string[]) {
    return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", env: gitEnvironment }).trim();
}

function fixture(context: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "evaluation-publication-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    const write = (file: string, content: string) => {
        fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        fs.writeFileSync(path.join(source, file), content);
    };
    git(source, "init", "--quiet", "--initial-branch=main");
    git(source, "config", "user.name", "Publication fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    for (const file of [agent, skill, ".github/skills/another/SKILL.md", ".agents/agents/other.agent.md"]) {
        write(file, "# Definition fixture\n");
    }
    write(".claude/agents/not-in-automatic-scope.agent.md", "# Explicit evaluation only\n");
    write("index.html", '<meta http-equiv="refresh" content="0;url=learn/">');
    write(".nojekyll", "");
    write("README.md", "# Setup\n");
    write("learn/index.html", "<main>Workshop fixture</main>");
    write("learn/manifest.json", '{"contentRoot":"../","setup":{"file":"README.md"}}\n');
    write("exercises/fixture.md", "# Exercise fixture\n");
    write("learn/assets/fixture.png", "Fixture image bytes");
    write("eval-badge.svg", "<svg>Old tracked image, not a publication</svg>");
    const commit = () => {
        git(source, "add", ".");
        git(source, "commit", "--quiet", "-m", "Fixture source");
        return git(source, "rev-parse", "HEAD");
    };
    const sourceSha = commit();
    const files = [agent, skill, ".github/skills/another/SKILL.md", ".agents/agents/other.agent.md"].sort();
    const results = files.map((fileName) => ({ fileName, score: 7, reasoning: "Fixture evaluation." }));
    const input = path.join(root, "results.jsonl");
    const writeResults = (entries: unknown[]) => fs.writeFileSync(input, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    writeResults(results);
    const identity = { repository, sourceSha, sourceRef: "refs/heads/main", runId: 100, runAttempt: 1 };
    return { root, source, input, files, results, identity, write, commit, writeResults };
}

async function snapshot(context: TestContext) {
    const f = fixture(context);
    const value = await createSnapshot(f.source, f.input, f.identity, "2026-10-12T12:00:00.000Z");
    return { ...f, value };
}

function runFor(value: EvaluationSnapshot) {
    return {
        id: value.runId, run_attempt: value.runAttempt, head_sha: value.sourceSha,
        head_branch: "main", head_repository: { full_name: repository },
        event: "push", status: "completed", conclusion: "success",
    };
}

function services(
    previous: EvaluationSnapshot | null,
    candidates: EvaluationSnapshot[],
    overrides: { expired?: boolean; httpStatus?: number; runs?: ReturnType<typeof runFor>[] } = {},
) {
    const calls: string[] = [];
    const logs: string[] = [];
    return {
        calls, logs,
        api(route: string): unknown {
            calls.push(route);
            if (route.includes("/workflows/evaluate.yml/runs?")) {
                const runs = overrides.runs ?? candidates.map(runFor);
                return { total_count: runs.length, workflow_runs: runs };
            }
            const id = Number(route.match(/\/runs\/(\d+)\/artifacts/)?.[1]);
            const value = candidates.find((candidate) => candidate.runId === id);
            assert.ok(value, `Unexpected API request: ${route}`);
            return { artifacts: [{ id, name: "evaluation-output", expired: overrides.expired ?? false }] };
        },
        download(id: number): unknown {
            calls.push(`download:${id}`);
            const value = candidates.find((candidate) => candidate.runId === id);
            assert.ok(value);
            return value;
        },
        fetch: async () => previous
            ? new Response(JSON.stringify(previous), { status: overrides.httpStatus ?? 200 })
            : new Response("Not found", { status: overrides.httpStatus ?? 404 }),
        log(message: string) { logs.push(message); },
    };
}

test("complete output contains the actual SVG, every discovered definition, and pinned source metadata", async (context) => {
    const f = await snapshot(context);
    assert.deepEqual(f.value.files, f.files);
    assert.equal(f.value.results.length, 4);
    assert.equal(f.value.sourceSha, f.identity.sourceSha);
    assert.equal(f.value.runAttempt, 1);
    assert.match(f.value.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(f.value.svg, new RegExp(f.identity.sourceSha.slice(0, 12)));
    const output = path.join(f.root, "output");
    writeSnapshot(f.value, output);
    assert.deepEqual(fs.readdirSync(output).sort(), ["eval-badge.svg", "results.jsonl", "snapshot.json"]);
    assert.equal(fs.readFileSync(path.join(output, "eval-badge.svg"), "utf8"), f.value.svg);
    assert.deepEqual(validateSnapshot(JSON.parse(fs.readFileSync(path.join(output, "snapshot.json"), "utf8")), repository), f.value);
    assert.equal(git(f.source, "status", "--porcelain"), "");
});

test("missing, duplicate, unexpected, malformed, and invalid results cannot become publishable", async (context) => {
    const f = fixture(context);
    for (const entries of [
        f.results.slice(1), [...f.results, f.results[0]], [...f.results, { fileName: "other.agent.md", score: 8, reasoning: "Unexpected." }],
        f.results.map((entry, index) => index === 0 ? { ...entry, score: 0 } : entry),
        f.results.map((entry, index) => index === 0 ? { ...entry, reasoning: "" } : entry),
    ]) {
        f.writeResults(entries);
        await assert.rejects(createSnapshot(f.source, f.input, f.identity));
    }
    fs.writeFileSync(f.input, "not JSON\n");
    await assert.rejects(createSnapshot(f.source, f.input, f.identity), /Invalid evaluation JSON/);
    f.writeResults(f.results);
    await assert.rejects(createSnapshot(f.source, f.input, { ...f.identity, sourceSha: "0".repeat(40) }), /checked-out commit/);
    f.writeResults(f.results.map((entry) => ({ ...entry, score: 1, reasoning: "Invalid frontmatter." })));
    assert.equal((await createSnapshot(f.source, f.input, f.identity)).results[0]?.score, 1);
});

test("snapshot validation rejects unsafe paths, incorrect repositories and SVG/result mismatches", async (context) => {
    const f = await snapshot(context);
    for (const changed of [
        { ...f.value, files: [...f.value.files, f.value.files[0]] },
        { ...f.value, files: ["../outside.agent.md"] },
        { ...f.value, repository: "another/repository" },
        { ...f.value, svg: "<svg>Wrong image</svg>" },
        { ...f.value, runId: 0 },
        { ...f.value, sourceSha: "not a revision" },
        { ...f.value, results: f.value.results.slice(1) },
    ]) {
        assert.throws(() => validateSnapshot(changed, repository));
    }
});

test("newer source commits win over late older runs, and run/attempt ordering breaks same-source ties", async (context) => {
    const f = await snapshot(context);
    f.write("README.md", "# Updated setup\n");
    const nextSha = f.commit();
    const next = { ...f.value, sourceSha: nextSha, runId: 101 };
    const history = [nextSha, f.identity.sourceSha];
    assert.equal(newerSnapshot(f.value, next, history), next);
    assert.equal(newerSnapshot(next, { ...f.value, runId: 999 }, history), next);
    assert.equal(newerSnapshot(next, { ...next, runId: 100, runAttempt: 10 }, history), next);
    const rerun = { ...next, runAttempt: 2 };
    assert.equal(newerSnapshot(next, rerun, history), rerun);
    assert.throws(() => newerSnapshot(next, { ...next, sourceRef: "refs/heads/feature" }, history), /ancestor/);
    assert.throws(() => newerSnapshot(null, { ...next, sourceSha: "0".repeat(40) }, history), /ancestor/);
});

test("initial publication preserves the entire tracked workshop and overlays complete results without branch writes", async (context) => {
    const f = await snapshot(context);
    fs.mkdirSync(path.join(f.source, "node_modules"));
    fs.writeFileSync(path.join(f.source, "node_modules", "untracked"), "Must not be published");
    const output = path.join(f.root, "site");
    const io = services(null, [f.value]);
    assert.deepEqual(await stagePages(f.source, output, repository, pagesUrl, io), f.value);
    for (const file of [".nojekyll", "index.html", "README.md", "learn/index.html", "learn/manifest.json",
        "exercises/fixture.md", "learn/assets/fixture.png"]) {
        assert.equal(fs.readFileSync(path.join(output, file), "utf8"), fs.readFileSync(path.join(f.source, file), "utf8"));
    }
    assert.ok(!fs.existsSync(path.join(output, ".git")));
    assert.ok(!fs.existsSync(path.join(output, "node_modules")));
    assert.equal(fs.readFileSync(path.join(output, "evaluation/eval-badge.svg"), "utf8"), f.value.svg);
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.identity.sourceSha);
    assert.deepEqual(git(f.source, "for-each-ref", "--format=%(refname)").split("\n"), ["refs/heads/main"]);
});

test("site-only updates retain the durable published evaluation after artifact expiration or failed evaluation", async (context) => {
    const f = await snapshot(context);
    f.write("README.md", "# Updated without a new complete evaluation\n");
    const nextSha = f.commit();
    const next = await createSnapshot(f.source, f.input, { ...f.identity, sourceSha: nextSha, runId: 101 });
    for (const [name, candidates, options] of [
        ["expired", [next], { expired: true }],
        ["failed", [], {}],
    ] as const) {
        const io = services(f.value, [...candidates], options);
        const output = path.join(f.root, name);
        assert.deepEqual(await stagePages(f.source, output, repository, pagesUrl, io), f.value);
        assert.match(fs.readFileSync(path.join(output, "README.md"), "utf8"), /Updated without/);
        assert.equal(fs.readFileSync(path.join(output, "evaluation/eval-badge.svg"), "utf8"), f.value.svg);
        assert.ok(!io.calls.some((call) => call.startsWith("download:")));
    }
});

test("successful evaluation discovery is paginated rather than restricted to the first run page", async (context) => {
    const f = await snapshot(context);
    const io = services(null, [f.value]);
    const baseApi = io.api;
    io.api = (route) => {
        if (!route.includes("/workflows/evaluate.yml/runs?")) return baseApi(route);
        io.calls.push(route);
        return {
            total_count: 101,
            workflow_runs: route.endsWith("page=1")
                ? Array.from({ length: 100 }, (_, index) => ({ ...runFor(f.value), id: 200 + index, event: "pull_request" }))
                : [runFor(f.value)],
        };
    };
    assert.deepEqual(await stagePages(f.source, path.join(f.root, "site"), repository, pagesUrl, io), f.value);
    assert.equal(io.calls.filter((call) => call.includes("/workflows/evaluate.yml/runs?")).length, 2);
});

test("publication selects the newest eligible main source, not the most recently completed older run", async (context) => {
    const f = await snapshot(context);
    f.write("README.md", "# Main advanced\n");
    const nextSha = f.commit();
    const next = await createSnapshot(f.source, f.input, { ...f.identity, sourceSha: nextSha, runId: 101 });
    const lateOld = { ...f.value, runId: 999 };
    const io = services(f.value, [lateOld, next]);
    assert.deepEqual(await stagePages(f.source, path.join(f.root, "site"), repository, pagesUrl, io), next);
    assert.deepEqual(io.calls.filter((call) => call.startsWith("download:")), ["download:101"]);
});

test("a newer published snapshot cannot be overwritten by an old completion or lower same-source attempt", async (context) => {
    const f = await snapshot(context);
    const latest = { ...f.value, runAttempt: 2 };
    const io = services(latest, [f.value]);
    assert.deepEqual(await stagePages(f.source, path.join(f.root, "site"), repository, pagesUrl, io), latest);
    assert.ok(!io.calls.some((call) => call.startsWith("download:")));
});

test("failed, cancelled, non-main, fork and unrelated-source runs cannot supply the public image", async (context) => {
    const f = await snapshot(context);
    const run = runFor(f.value);
    const io = services(null, [f.value], { runs: [
        { ...run, conclusion: "failure" }, { ...run, conclusion: "cancelled" },
        { ...run, head_branch: "feature" }, { ...run, head_repository: { full_name: "fork/workshop" } },
        { ...run, event: "pull_request" }, { ...run, head_sha: "0".repeat(40) },
    ] });
    const output = path.join(f.root, "site");
    assert.equal(await stagePages(f.source, output, repository, pagesUrl, io), null);
    assert.match(fs.readFileSync(path.join(output, "evaluation/eval-badge.svg"), "utf8"), /No complete evaluation published yet/);
    assert.ok(!fs.existsSync(path.join(output, "evaluation/snapshot.json")));
    assert.ok(io.logs.some((message) => message.startsWith("::warning::")));
});

test("HTTP, invalid snapshot, API, and artifact identity failures are explicit and do not stage replacement results", async (context) => {
    const f = await snapshot(context);
    const cases = [
        services(f.value, [], { httpStatus: 403 }),
        { ...services(null, []), fetch: async () => new Response("invalid JSON") },
        { ...services(f.value, []), api: () => { throw new Error("GitHub unavailable"); } },
        { ...services(null, [f.value]), download: () => ({ ...f.value, runAttempt: 2 }) },
        { ...services(null, [f.value]), download: () => ({ ...f.value, svg: "<svg>Malformed</svg>" }) },
    ];
    for (const [index, io] of cases.entries()) {
        const output = path.join(f.root, `failed-${index}`);
        await assert.rejects(stagePages(f.source, output, repository, pagesUrl, io));
        assert.ok(!fs.existsSync(output));
    }
});

test("the workflow bundle command fails partial successful-process output rather than reusing the tracked SVG", async (context) => {
    const f = fixture(context);
    f.writeResults(f.results.slice(1));
    const output = path.join(f.root, "bundle");
    const args = ["--import", "tsx", "publication.ts", "bundle", "--directory", f.source, "--input", f.input, "--output", output];
    const env = {
        ...gitEnvironment, GITHUB_REPOSITORY: repository, GITHUB_SHA: f.identity.sourceSha,
        GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1",
    };
    const failed = spawnSync(process.execPath, args, { cwd: evaluatorDirectory, encoding: "utf8", env });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /::error::Missing evaluation results/);
    assert.ok(!fs.existsSync(output));
    f.writeResults(f.results);
    const complete = spawnSync(process.execPath, args, { cwd: evaluatorDirectory, encoding: "utf8", env });
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(fs.readFileSync(path.join(output, "eval-badge.svg"), "utf8"), /<svg xmlns=/);
    assert.equal(fs.readFileSync(path.join(f.source, "eval-badge.svg"), "utf8"), "<svg>Old tracked image, not a publication</svg>");
});

test("Pages workflow publishes independently of evaluation, serializes deployment and scopes write permissions", () => {
    const workflowPath = path.join(evaluatorDirectory, "../.github/workflows/pages.yml");
    const document = parseDocument(fs.readFileSync(workflowPath, "utf8"));
    assert.deepEqual(document.errors, []);
    const workflow = document.toJS();
    assert.deepEqual(workflow.on.push, { branches: ["main"] });
    assert.deepEqual(workflow.on.workflow_run, {
        workflows: ["Evaluate Agents & Skills"], types: ["completed"], branches: ["main"],
    });
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
    assert.deepEqual(workflow.permissions, {});
    assert.deepEqual(workflow.jobs.build.permissions, { contents: "read", actions: "read", pages: "read" });
    assert.deepEqual(workflow.jobs.deploy.permissions, { pages: "write", "id-token": "write" });
    assert.equal(workflow.jobs.deploy.needs, "build");
    assert.equal(workflow.jobs.deploy.environment.name, "github-pages");
    assert.match(workflow.jobs.build.if, /refs\/heads\/main/);
    assert.match(workflow.jobs.build.if, /conclusion == 'success'/);
    const steps = workflow.jobs.build.steps;
    assert.deepEqual(steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v7").with, {
        ref: "main", "fetch-depth": 0, "persist-credentials": false,
    });
    assert.ok(steps.some((step: { uses?: string }) => step.uses === "actions/upload-pages-artifact@v4"));
    for (const step of steps.filter((step: { run?: string }) => step.run)) {
        assert.doesNotMatch(step.run, /git\s+(?:commit|push)|cli.ts evaluate/);
        assert.equal(spawnSync("bash", ["-n"], { input: step.run }).status, 0);
    }
    assert.equal(workflow.jobs.deploy.steps[0].uses, "actions/deploy-pages@v4");
});

test("generated SVG bytes match the scores rather than YAML workflow source", async (context) => {
    const f = await snapshot(context);
    assert.equal(f.value.svg, generateBadgeSvg(f.value.results, `2026-10-12 ${f.identity.sourceSha.slice(0, 12)}`));
    assert.match(f.value.svg, /Average \(4 items\)/);
    assert.doesNotMatch(f.value.svg, /name: Evaluate|workflow_dispatch:/);
});
