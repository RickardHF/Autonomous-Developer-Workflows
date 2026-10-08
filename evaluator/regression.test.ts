import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
    compareResults, compareScores, discover, escapeAnnotation, escapeMarkdown,
    evaluateRegression, parseChanges, parseResults, selectArtifacts, writeManifest,
} from "./regression.js";

const evaluatorDirectory = path.dirname(fileURLToPath(import.meta.url));
const runnerPath = path.join(evaluatorDirectory, "regression.ts");
const agent = ".github/agents/example.agent.md";
const skill = ".agents/skills/example/SKILL.md";

function temporaryDirectory(t: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "evaluation-regression-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function runGit(directory: string, args: string[]) {
    const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function write(directory: string, file: string, content: string) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function commit(directory: string) {
    runGit(directory, ["add", "."]);
    runGit(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm",
        "fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"]);
    return runGit(directory, ["rev-parse", "HEAD"]);
}

function snapshots(t: TestContext, files: Record<string, string> = { [agent]: "score=8\n" }) {
    const root = temporaryDirectory(t);
    const main = path.join(root, "main");
    const candidate = path.join(root, "candidate");
    fs.mkdirSync(main);
    runGit(main, ["init", "--quiet", "--initial-branch=main"]);
    for (const [file, content] of Object.entries(files)) write(main, file, content);
    const mainSha = commit(main);
    runGit(root, ["clone", "--quiet", "--no-hardlinks", main, candidate]);
    return { root, main, candidate, mainSha, output: path.join(root, "output") };
}

function controlledEvaluator(targets: string[], directory: string) {
    return {
        status: 0,
        stderr: "",
        stdout: targets.map((target) => {
            const file = fs.statSync(target).isDirectory() ? path.join(target, "SKILL.md") : target;
            const match = fs.readFileSync(file, "utf8").match(/score=(\d+(?:\.\d+)?)/);
            assert.ok(match?.[1], `No controlled score in ${file}`);
            return JSON.stringify({ fileName: path.relative(directory, file), score: Number(match[1]), reasoning: "Controlled evaluation." });
        }).join("\n"),
    };
}

test("NUL-delimited Git changes preserve unusual filenames and rename origins", () => {
    assert.deepEqual(parseChanges(`M\0.github/agents/a b.agent.md\0R100\0${skill}\0.claude/skills/a/SKILL.md\0`), [
        { status: "M", path: ".github/agents/a b.agent.md" },
        { status: "R100", previousPath: skill, path: ".claude/skills/a/SKILL.md" },
    ]);
    assert.deepEqual(parseChanges(""), []);
    for (const invalid of ["M", "M\0", "R100\0old\0", "WHAT\0file\0", "M\0../outside\0"]) {
        assert.throws(() => parseChanges(invalid));
    }
});

test("selection covers agents and complete skills in all three roots", () => {
    for (const root of [".github", ".agents", ".claude"]) {
        const agentFile = `${root}/nested/a.agent.md`;
        const skillFile = `${root}/skills/a/SKILL.md`;
        const support = `${root}/skills/a/scripts/check.ts`;
        const files = [agentFile, skillFile, support];
        const result = selectArtifacts(files, files, files, [
            { status: "M", path: agentFile }, { status: "M", path: support }, { status: "M", path: skillFile },
        ]);
        assert.deepEqual(result.artifacts, [agentFile, skillFile].sort().map((file) => ({
            path: file, kind: file === agentFile ? "agent" : "skill", mainPath: file,
        })));
        assert.deepEqual(result.deleted, []);
    }
});

test("supporting-file additions, deletions, and hidden changes select surviving skills once", () => {
    const files = [skill, ".agents/skills/example/removed.txt", ".agents/skills/example/.hidden"];
    const result = selectArtifacts(files, [skill, ".agents/skills/example/added.txt"], files, [
        { status: "D", path: files[1]! },
        { status: "D", path: files[2]! },
        { status: "A", path: ".agents/skills/example/added.txt" },
    ]);
    assert.deepEqual(result.artifacts, [{ path: skill, kind: "skill", mainPath: skill }]);
});

test("supporting-file moves select both affected skills, but unrelated files do not", () => {
    const other = ".claude/skills/other/SKILL.md";
    const files = [skill, other, ".agents/skills/example/support.txt"];
    const result = selectArtifacts(files, [skill, other, ".claude/skills/other/support.txt"], files, [
        { status: "R100", previousPath: ".agents/skills/example/support.txt", path: ".claude/skills/other/support.txt" },
        { status: "M", path: "README.md" },
        { status: "M", path: ".claude/agents/ordinary.md" },
        { status: "M", path: "outside/example.agent.md" },
        { status: "M", path: ".github/workflows/evaluate.yml" },
    ]);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.path), [skill, other].sort());
    assert.deepEqual(selectArtifacts(files, files, files, [{ status: "M", path: "README.md" }]).artifacts, []);
});

test("new definitions use zero baselines and full deletions are reported separately", () => {
    const newAgent = ".claude/agents/new.agent.md";
    const newSkill = ".github/skills/new/SKILL.md";
    const result = selectArtifacts([agent, skill], [newAgent, newSkill], [agent, skill], [
        { status: "D", path: agent }, { status: "D", path: skill },
        { status: "A", path: newAgent }, { status: "A", path: newSkill },
    ]);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.mainPath), [null, null]);
    assert.deepEqual(result.deleted.map((artifact) => artifact.path).sort(), [agent, skill].sort());
});

test("agent and skill definition renames preserve their main baseline", () => {
    const nextAgent = ".claude/agents/moved.agent.md";
    const nextSkill = ".github/skills/moved/SKILL.md";
    const result = selectArtifacts([agent, skill], [nextAgent, nextSkill], [agent, skill], [
        { status: "R100", previousPath: agent, path: nextAgent },
        { status: "R100", previousPath: skill, path: nextSkill },
    ]);
    assert.deepEqual(result.artifacts.map((artifact) => [artifact.path, artifact.mainPath]), [
        [nextAgent, agent], [nextSkill, skill],
    ]);
    assert.deepEqual(result.deleted, []);
});

test("discovery includes early PR commits, not just the latest commit", (t) => {
    const fixture = snapshots(t, { [skill]: "score=8\n", ".agents/skills/example/helper.txt": "old\n" });
    write(fixture.candidate, ".agents/skills/example/helper.txt", "changed\n");
    commit(fixture.candidate);
    write(fixture.candidate, "README.md", "unrelated later commit\n");
    const headSha = commit(fixture.candidate);
    const manifest = discover(fixture.candidate, fixture.mainSha, headSha);
    assert.deepEqual(manifest.artifacts, [{ path: skill, kind: "skill", mainPath: skill }]);
    assert.equal(manifest.headSha, headSha);
    assert.equal(manifest.mainSha, fixture.mainSha);
});

test("discovery recognizes Git-detected directory renames", (t) => {
    const fixture = snapshots(t, { [skill]: "score=8\n", ".agents/skills/example/helper.txt": "support\n" });
    fs.mkdirSync(path.join(fixture.candidate, ".claude", "skills"), { recursive: true });
    fs.renameSync(path.join(fixture.candidate, ".agents/skills/example"), path.join(fixture.candidate, ".claude/skills/moved"));
    const headSha = commit(fixture.candidate);
    const manifest = discover(fixture.candidate, fixture.mainSha, headSha);
    assert.deepEqual(manifest.artifacts, [{ path: ".claude/skills/moved/SKILL.md", kind: "skill", mainPath: skill }]);
    assert.deepEqual(manifest.deleted, []);
});

test("result parsing normalizes the CLI working directory and requires exact coverage", () => {
    const snapshot = path.resolve("snapshot");
    const cwd = path.join(snapshot, "evaluator");
    const result = (score = 8, reasoning = "Valid reasoning.") => JSON.stringify({ fileName: `../${agent}`, score, reasoning });
    assert.equal(parseResults(`${result()}\n`, [agent], snapshot, cwd).get(agent)?.score, 8);
    const absolute = JSON.stringify({ fileName: path.join(snapshot, agent), score: 8, reasoning: "Absolute filename." });
    assert.equal(parseResults(absolute, [agent], snapshot, cwd).size, 1);
    assert.throws(() => parseResults("", [agent], snapshot, cwd), /Missing evaluation results/);
    assert.throws(() => parseResults(`${result()}\n${result()}`, [agent], snapshot, cwd), /Duplicate/);
    assert.throws(() => parseResults(result(), [], snapshot, cwd), /Unexpected/);
    assert.throws(() => parseResults("not json", [agent], snapshot, cwd), /Invalid evaluation JSON/);
    for (const score of [0, 11, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => parseResults(result(score), [agent], snapshot, cwd), /Invalid evaluation result/);
    }
    for (const value of [
        [], null, { fileName: `../${agent}`, score: "8", reasoning: "Wrong score type." },
        { fileName: `../${agent}`, score: 8, reasoning: " " },
        { fileName: `../${agent}`, score: 8 },
    ]) {
        assert.throws(() => parseResults(JSON.stringify(value), [agent], snapshot, cwd), /Invalid evaluation result/);
    }
    assert.throws(() => parseResults(JSON.stringify({
        fileName: "../../outside.agent.md", score: 8, reasoning: "Outside snapshot.",
    }), [agent], snapshot, cwd), /Unexpected/);
});

test("per-artifact comparison fails only for drops strictly greater than one", () => {
    for (const [mainScore, score, delta, regression] of [
        [8, 8, 0, false], [8, 9, 1, false], [8, 7, -1, false], [8, 6, -2, true],
        [8.3, 7.3, -1, false], [9.1, 8.1, -1, false], [8.3, 7.29, -1.01, true],
        [8.3, 7.3001, -0.9999, false], [8.3, 7.2999, -1.0001, true], [0, 1, 1, false],
    ] as const) {
        assert.deepEqual(compareScores(mainScore, score), { delta, regression });
    }
    const artifacts = [
        { path: agent, kind: "agent" as const, mainPath: agent },
        { path: skill, kind: "skill" as const, mainPath: null },
    ];
    const main = new Map([[agent, { fileName: agent, score: 9, reasoning: "Previous." }]]);
    const candidate = new Map([
        [agent, { fileName: agent, score: 7, reasoning: "Regression." }],
        [skill, { fileName: skill, score: 10, reasoning: "New strong skill." }],
    ]);
    const comparisons = compareResults(artifacts, main, candidate);
    assert.equal(comparisons[0]?.regression, true);
    assert.equal(comparisons[1]?.mainScore, 0);
    assert.equal(comparisons[1]?.regression, false);
    assert.throws(() => compareResults(artifacts, new Map(), candidate), /incomplete/);
    assert.throws(() => compareResults(artifacts, main, new Map()), /incomplete/);
});

test("report escaping prevents annotation commands and Markdown injection", () => {
    assert.equal(escapeAnnotation("line%\r\n::error::oops"), "line%25%0D%0A::error::oops");
    const escaped = escapeMarkdown("a|b\n<script> [link](url) `code` &");
    assert.equal(escaped, "a&#124;b<br>&lt;script&gt; &#91;link&#93;&#40;url&#41; &#96;code&#96; &amp;");
});

test("runner evaluates main and candidate using the same main evaluator directory", (t) => {
    const fixture = snapshots(t);
    write(fixture.candidate, agent, "score=6\n");
    const headSha = commit(fixture.candidate);
    const manifest = discover(fixture.candidate, fixture.mainSha, headSha);
    const calls: string[][] = [];
    const comparisons = evaluateRegression(manifest, fixture.main, fixture.candidate, fixture.output, (targets, cwd) => {
        assert.equal(cwd, path.join(fixture.main, "evaluator"));
        calls.push(targets);
        return controlledEvaluator(targets, cwd);
    });
    assert.deepEqual(calls, [[path.join(fixture.main, agent)], [path.join(fixture.candidate, agent)]]);
    assert.equal(comparisons[0]?.regression, true);
    assert.match(fs.readFileSync(path.join(fixture.output, "summary.md"), "utf8"), /\| 8 \| 6 \| -2 \| FAIL \|/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.output, "comparison.json"), "utf8")).comparisons.length, 1);
    assert.ok(fs.readFileSync(path.join(fixture.output, "main.jsonl"), "utf8"));
    assert.ok(fs.readFileSync(path.join(fixture.output, "candidate.jsonl"), "utf8"));
});

test("runner compares against current main rather than merge-base contents", (t) => {
    const fixture = snapshots(t);
    write(fixture.candidate, agent, "score=7\n");
    const headSha = commit(fixture.candidate);
    write(fixture.main, agent, "score=9\n");
    const mainSha = commit(fixture.main);
    runGit(fixture.candidate, ["fetch", "--quiet", "origin", "main"]);
    const manifest = discover(fixture.candidate, mainSha, headSha);
    const comparisons = evaluateRegression(manifest, fixture.main, fixture.candidate, fixture.output, controlledEvaluator);
    assert.equal(comparisons[0]?.mainScore, 9);
    assert.equal(comparisons[0]?.score, 7);
    assert.equal(comparisons[0]?.regression, true);
});

test("new-artifact and no-change runs do not make unnecessary evaluations", (t) => {
    const fixture = snapshots(t, { "README.md": "initial\n" });
    write(fixture.candidate, skill, "score=5\n");
    const headSha = commit(fixture.candidate);
    const manifest = discover(fixture.candidate, fixture.mainSha, headSha);
    let calls = 0;
    const comparisons = evaluateRegression(manifest, fixture.main, fixture.candidate, fixture.output, (targets, cwd) => {
        calls++;
        return controlledEvaluator(targets, cwd);
    });
    assert.equal(calls, 1);
    assert.equal(comparisons[0]?.mainScore, 0);
    const empty = { ...manifest, artifacts: [] };
    evaluateRegression(empty, fixture.main, fixture.candidate, fixture.output, () => {
        assert.fail("No-change runs must not invoke the evaluator.");
    });
    assert.match(fs.readFileSync(path.join(fixture.output, "summary.md"), "utf8"), /No Copilot requests were made/);
});

test("runner fails incomplete output even when the evaluator exits successfully", (t) => {
    const fixture = snapshots(t);
    write(fixture.candidate, agent, "score=7\n");
    const manifest = discover(fixture.candidate, fixture.mainSha, commit(fixture.candidate));
    evaluateRegression(manifest, fixture.main, fixture.candidate, fixture.output, controlledEvaluator);
    for (const failedSide of ["main", "candidate"]) {
        let calls = 0;
        assert.throws(() => evaluateRegression(manifest, fixture.main, fixture.candidate, fixture.output, (targets, cwd) => {
            const side = calls++ === 0 ? "main" : "candidate";
            return side === failedSide ? { status: 0, stdout: "", stderr: "Evaluation failed.\n" } : controlledEvaluator(targets, cwd);
        }), /Missing evaluation results/);
        assert.match(fs.readFileSync(path.join(fixture.output, `${failedSide}.stderr.txt`), "utf8"), /Evaluation failed/);
        assert.match(fs.readFileSync(path.join(fixture.output, "summary.md"), "utf8"), /Evaluation failed/);
        assert.equal(fs.existsSync(path.join(fixture.output, "comparison.json")), false);
        if (failedSide === "main") assert.equal(fs.existsSync(path.join(fixture.output, "candidate.jsonl")), false);
    }
});

test("runner preserves evidence on nonzero exits, signals, and launch failures", (t) => {
    const fixture = snapshots(t);
    write(fixture.candidate, agent, "score=7\n");
    const manifest = discover(fixture.candidate, fixture.mainSha, commit(fixture.candidate));
    for (const failure of [
        { status: 1, signal: null }, { status: null, signal: "SIGTERM" as const },
        { status: null, error: new Error("Unable to launch evaluator.") },
    ]) {
        assert.throws(() => evaluateRegression(manifest, fixture.main, fixture.candidate, fixture.output,
            () => ({ ...failure, stdout: "partial output", stderr: "controlled failure\n" })), /main evaluator/);
        assert.equal(fs.readFileSync(path.join(fixture.output, "main.jsonl"), "utf8"), "partial output");
        assert.equal(fs.readFileSync(path.join(fixture.output, "main.stderr.txt"), "utf8"), "controlled failure\n");
        assert.ok(fs.readFileSync(path.join(fixture.output, "error.txt"), "utf8"));
    }
    assert.throws(() => evaluateRegression({ ...manifest, mainSha: "0".repeat(40) },
        fixture.main, fixture.candidate, fixture.output, controlledEvaluator), /pinned commit SHAs/);
});

test("native TypeScript CLI discovers changes and fails a controlled regression without executing the PR evaluator", (t) => {
    const stubCli = `
import fs from "node:fs";
import path from "node:path";
for (const target of process.argv.slice(process.argv.indexOf("--files") + 1, -1)) {
    const file = fs.statSync(target).isDirectory() ? path.join(target, "SKILL.md") : target;
    const score = Number(fs.readFileSync(file, "utf8").match(/score=(\\d+)/)[1]);
    console.log(JSON.stringify({fileName: path.relative(process.cwd(), file), score, reasoning: "Stubbed score."}));
}
`;
    const fixture = snapshots(t, { [agent]: "score=8\n", "evaluator/cli.ts": stubCli });
    fs.symlinkSync(path.join(evaluatorDirectory, "node_modules"), path.join(fixture.main, "evaluator/node_modules"), "dir");
    write(fixture.candidate, agent, "score=6\n");
    write(fixture.candidate, "evaluator/cli.ts", 'throw new Error("The PR evaluator must never run.");\n');
    const headSha = commit(fixture.candidate);
    const discoverResult = spawnSync(process.execPath, [runnerPath, "discover",
        "--repository", fixture.candidate, "--main-ref", fixture.mainSha, "--head-ref", headSha, "--output", fixture.output,
    ], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: path.join(fixture.root, "github-output") } });
    assert.equal(discoverResult.status, 0, discoverResult.stderr);
    assert.equal(fs.readFileSync(path.join(fixture.root, "github-output"), "utf8"), "has_artifacts=true\n");
    const evaluateResult = spawnSync(process.execPath, [runnerPath, "evaluate",
        "--main-directory", fixture.main, "--candidate-directory", fixture.candidate, "--output", fixture.output,
    ], { encoding: "utf8" });
    assert.equal(evaluateResult.status, 1, evaluateResult.stderr);
    assert.match(evaluateResult.stderr, /::error file=\.github\/agents\/example\.agent\.md::Score dropped from 8 to 6/);
    assert.doesNotMatch(evaluateResult.stderr, /PR evaluator must never run/);
    assert.match(fs.readFileSync(path.join(fixture.output, "summary.md"), "utf8"), /FAIL/);
});

test("CLI rejects a malformed manifest instead of silently passing", (t) => {
    const directory = temporaryDirectory(t);
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
        mainSha: "a".repeat(40), headSha: "b".repeat(40),
        artifacts: [{ path: "../outside.agent.md", kind: "agent", mainPath: null }], deleted: [],
    }));
    const result = spawnSync(process.execPath, [runnerPath, "evaluate",
        "--main-directory", directory, "--candidate-directory", directory, "--output", directory,
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid artifact/);
});

test("CLI discovery reports deletions and no-op output without invoking Copilot", (t) => {
    const fixture = snapshots(t);
    fs.unlinkSync(path.join(fixture.candidate, agent));
    write(fixture.candidate, "README.md", "surviving file\n");
    const headSha = commit(fixture.candidate);
    const manifest = discover(fixture.candidate, fixture.mainSha, headSha);
    assert.deepEqual(manifest.artifacts, []);
    assert.deepEqual(manifest.deleted, [{ path: agent, kind: "agent" }]);
    writeManifest(manifest, fixture.output);
    const summary = fs.readFileSync(path.join(fixture.output, "summary.md"), "utf8");
    assert.match(summary, /No Copilot requests were made/);
    assert.match(summary, /Deletions \(excluded from comparison\)/);
    assert.match(summary, /example\.agent\.md/);
});

test("the evaluator includes hidden skill supporting files (mocked SDK, no live calls)", (t) => {
    const directory = temporaryDirectory(t);
    write(directory, "SKILL.md", `---\nname: ${path.basename(directory)}\ndescription: Includes supporting context.\n---\n# Fixture skill\n`);
    write(directory, ".hidden/context.txt", "HIDDEN_SUPPORT_MARKER");
    const cliPath = path.join(evaluatorDirectory, "cli.ts");
    const script = `
import { mock } from "node:test";
mock.module("@github/copilot-sdk", { namedExports: {
    defineTool: (name, options) => ({ name, ...options }),
    CopilotClient: class {
        async start() {}
        async stop() {}
        async createSession() {
            return { sendAndWait: async (prompt) => ({ data: { toolRequests: [{
                name: "evaluate", arguments: {
                    score: 8, reasoning: prompt.includes("HIDDEN_SUPPORT_MARKER") ? "Hidden support included." : "Hidden support missing."
                }
            }] } }) };
        }
    }
} });
process.argv = [process.execPath, "evaluate", "--files", ${JSON.stringify(directory)}, "--json"];
await import(${JSON.stringify(cliPath)});
`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--experimental-test-module-mocks",
        "--input-type=module", "--eval", script], { cwd: evaluatorDirectory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).reasoning, "Hidden support included.");
});

test("workflow exposes a stable check, correct PR events, no path filters, and guarded evaluation", () => {
    const workflow = fs.readFileSync(path.join(evaluatorDirectory, "../.github/workflows/evaluation-regression.yml"), "utf8");
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/);
    assert.match(workflow, /name: Agent and skill score regression/);
    assert.match(workflow, /if: github\.event\.pull_request\.draft == false/);
    assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
    assert.doesNotMatch(workflow, /pull_request_target|contents: write|git push|git commit/);
    assert.doesNotMatch(workflow, /Reject fork PRs|HEAD_REPOSITORY|head\.repo\.full_name/);
    assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    assert.match(workflow, /ref: \$\{\{ steps\.refs\.outputs\.main_sha \}\}/);
    for (const step of ["Install main's evaluator dependencies", "Install Copilot CLI", "Evaluate and compare changed artifacts"]) {
        const index = workflow.indexOf(`- name: ${step}`);
        assert.ok(index >= 0);
        assert.match(workflow.slice(index).split(/\n      - name:/)[0]!, /if: steps\.discover\.outputs\.has_artifacts == 'true'/);
    }
    assert.match(workflow, /COPILOT_GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(workflow, /cancel-in-progress: true/);
});
