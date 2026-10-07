import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type ArtifactKind = "agent" | "skill";
type Definition = { path: string; kind: ArtifactKind };
type Artifact = Definition & { mainPath: string | null };
type Change = { status: string; path: string; previousPath?: string };
type Manifest = {
    mainSha: string;
    headSha: string;
    artifacts: Artifact[];
    deleted: Definition[];
};
type Result = { fileName: string; score: number; reasoning: string };
type Comparison = Artifact & {
    mainScore: number;
    score: number;
    delta: number;
    regression: boolean;
    mainReasoning: string;
    reasoning: string;
};
type EvaluationProcess = {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
    signal?: NodeJS.Signals | null;
};
type Evaluator = (targets: string[], directory: string) => EvaluationProcess;

const roots = [".github/", ".agents/", ".claude/"];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(file: string): ArtifactKind | undefined {
    if (!roots.some((root) => file.startsWith(root))) return undefined;
    if (file.endsWith(".agent.md")) return "agent";
    if (path.posix.basename(file) === "SKILL.md") return "skill";
    return undefined;
}

function validatePath(file: string) {
    if (path.posix.isAbsolute(file) || file.split("/").some((part) => part === ".." || part === "." || part === "")) {
        throw new Error(`Invalid repository-relative path: ${JSON.stringify(file)}`);
    }
}

export function parseChanges(output: string): Change[] {
    if (!output) return [];
    if (!output.endsWith("\0")) throw new Error("Git change output is not NUL-terminated.");
    const fields = output.slice(0, -1).split("\0");
    const changes: Change[] = [];
    for (let index = 0; index < fields.length;) {
        const status = fields[index++];
        if (!status || !/^(?:[ADMTUXB]|[RC]\d+)$/.test(status)) {
            throw new Error(`Invalid Git change status: ${JSON.stringify(status)}`);
        }
        const firstPath = fields[index++];
        if (!firstPath) throw new Error("Missing path in Git change output.");
        validatePath(firstPath);
        if (status.startsWith("R") || status.startsWith("C")) {
            const nextPath = fields[index++];
            if (!nextPath) throw new Error("Missing destination in Git rename/copy output.");
            validatePath(nextPath);
            changes.push({ status, previousPath: firstPath, path: nextPath });
        } else {
            changes.push({ status, path: firstPath });
        }
    }
    return changes;
}

export function selectArtifacts(mainFiles: string[], headFiles: string[], baseFiles: string[], changes: Change[]) {
    const main = new Set(mainFiles);
    const head = new Set(headFiles);
    const base = new Set(baseFiles);
    const headSkills = headFiles.filter((file) => kindOf(file) === "skill");
    const baseSkills = baseFiles.filter((file) => kindOf(file) === "skill");
    const selected = new Set<string>();
    const deleted = new Map<string, Definition>();
    const renames = new Map<string, string>();

    for (const change of changes) {
        if (change.status.startsWith("R") && change.previousPath &&
            kindOf(change.path) && kindOf(change.path) === kindOf(change.previousPath)) {
            renames.set(change.path, change.previousPath);
        }
        const changedPaths = change.previousPath ? [change.previousPath, change.path] : [change.path];
        for (const file of changedPaths) {
            if (head.has(file) && kindOf(file)) selected.add(file);
            for (const skill of headSkills) {
                if (file.startsWith(`${path.posix.dirname(skill)}/`)) selected.add(skill);
            }
            const removed = base.has(file) && kindOf(file) ? [file] : [];
            for (const skill of baseSkills) {
                if (file.startsWith(`${path.posix.dirname(skill)}/`)) removed.push(skill);
            }
            for (const definition of removed) {
                const kind = kindOf(definition);
                if (kind && !head.has(definition)) deleted.set(definition, { path: definition, kind });
            }
        }
    }

    const artifacts: Artifact[] = [...selected].sort().map((file) => {
        const kind = kindOf(file);
        if (!kind) throw new Error(`Unsupported artifact: ${file}`);
        const previous = renames.get(file);
        if (previous) deleted.delete(previous);
        return {
            path: file,
            kind,
            mainPath: main.has(file) ? file : previous && main.has(previous) ? previous : null,
        };
    });
    return { artifacts, deleted: [...deleted.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

function git(repository: string, args: string[]): string {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
}

export function discover(repository: string, mainRef: string, headRef: string): Manifest {
    const mainSha = git(repository, ["rev-parse", "--verify", "--end-of-options", `${mainRef}^{commit}`]).trim();
    const headSha = git(repository, ["rev-parse", "--verify", "--end-of-options", `${headRef}^{commit}`]).trim();
    const baseSha = git(repository, ["merge-base", mainSha, headSha]).trim();
    const filesAt = (ref: string) => git(repository, [
        "ls-tree", "-r", "-z", "--name-only", ref, "--", ".github", ".agents", ".claude",
    ]).split("\0").filter(Boolean);
    const changes = parseChanges(git(repository, [
        "diff", "--name-status", "-z", "--find-renames", `${baseSha}..${headSha}`, "--", ".github", ".agents", ".claude",
    ]));
    return { mainSha, headSha, ...selectArtifacts(filesAt(mainSha), filesAt(headSha), filesAt(baseSha), changes) };
}

export function parseResults(output: string, expected: string[], snapshotDirectory: string, cliDirectory: string): Map<string, Result> {
    const wanted = new Set(expected);
    const results = new Map<string, Result>();
    for (const [index, line] of output.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch (error) {
            throw new Error(`Invalid evaluation JSON on line ${index + 1}.`, { cause: error });
        }
        if (!isRecord(value) || typeof value.fileName !== "string" || !value.fileName ||
            typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 1 || value.score > 10 ||
            typeof value.reasoning !== "string" || !value.reasoning.trim()) {
            throw new Error(`Invalid evaluation result on line ${index + 1}.`);
        }
        const fileName = path.relative(snapshotDirectory, path.resolve(cliDirectory, value.fileName)).split(path.sep).join("/");
        if (!wanted.has(fileName)) throw new Error(`Unexpected evaluation result: ${JSON.stringify(fileName)}`);
        if (results.has(fileName)) throw new Error(`Duplicate evaluation result: ${JSON.stringify(fileName)}`);
        results.set(fileName, { fileName, score: value.score, reasoning: value.reasoning });
    }
    const missing = expected.filter((file) => !results.has(file));
    if (missing.length) throw new Error(`Missing evaluation results: ${missing.map((file) => JSON.stringify(file)).join(", ")}`);
    return results;
}

export function compareScores(mainScore: number, score: number) {
    // Compare decimal units so an exactly-one-point fractional drop does not fail due to floating-point subtraction.
    const decimalPlaces = (value: number) => value.toString().split(".")[1]?.length ?? 0;
    const places = Math.max(decimalPlaces(mainScore), decimalPlaces(score));
    const factor = 10n ** BigInt(places);
    const units = (value: number) => {
        const [whole, fraction = ""] = value.toString().split(".");
        return BigInt(`${whole}${fraction.padEnd(places, "0")}`);
    };
    const difference = units(score) - units(mainScore);
    return { delta: Number(difference) / Number(factor), regression: difference < -factor };
}

export function compareResults(artifacts: Artifact[], main: Map<string, Result>, candidate: Map<string, Result>): Comparison[] {
    return artifacts.map((artifact) => {
        const previous = artifact.mainPath === null ? undefined : main.get(artifact.mainPath);
        const current = candidate.get(artifact.path);
        if (!current || (artifact.mainPath !== null && !previous)) {
            throw new Error(`Cannot compare incomplete results for ${JSON.stringify(artifact.path)}.`);
        }
        const mainScore = previous?.score ?? 0;
        return {
            ...artifact,
            mainScore,
            score: current.score,
            ...compareScores(mainScore, current.score),
            mainReasoning: previous?.reasoning ?? "New artifact: absent from main.",
            reasoning: current.reasoning,
        };
    });
}

export function escapeMarkdown(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/[\\`*_{}[\]()!|]/g, (character) => `&#${character.charCodeAt(0)};`)
        .replace(/\r?\n|\r/g, "<br>");
}

export function escapeAnnotation(value: string): string {
    return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function renderSummary(manifest: Manifest, comparisons: Comparison[], error?: string): string {
    const lines = [
        "## Agent and skill score regression", "",
        `Main: \`${manifest.mainSha}\`  `,
        `PR head: \`${manifest.headSha}\``, "",
        "An artifact fails when its score drops by **more than 1 point**. New artifacts have a main score of 0.", "",
    ];
    if (error) lines.push(`**Evaluation failed:** ${escapeMarkdown(error)}`, "");
    if (comparisons.length) {
        lines.push("| Artifact | Main | PR | Change | Result | Main reasoning | PR reasoning |",
            "| --- | --- | --- | --- | --- | --- | --- |");
        for (const comparison of comparisons) {
            const label = comparison.mainPath && comparison.mainPath !== comparison.path
                ? `${comparison.path} (renamed from ${comparison.mainPath})` : comparison.path;
            lines.push(`| ${escapeMarkdown(label)} | ${comparison.mainScore} | ${comparison.score} | ${comparison.delta > 0 ? "+" : ""}${comparison.delta} | ${comparison.regression ? "FAIL" : "PASS"} | ${escapeMarkdown(comparison.mainReasoning)} | ${escapeMarkdown(comparison.reasoning)} |`);
        }
    } else if (!manifest.artifacts.length) {
        lines.push("No changed surviving agents or skills require evaluation. No Copilot requests were made.");
    } else if (!error) {
        lines.push(`Selected ${manifest.artifacts.length} artifact(s). Evaluation has not completed.`);
    }
    if (manifest.deleted.length) {
        lines.push("", "### Deletions (excluded from comparison)", "");
        for (const definition of manifest.deleted) lines.push(`- ${escapeMarkdown(definition.path)}`);
    }
    return `${lines.join("\n")}\n`;
}

function readManifest(outputDirectory: string): Manifest {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(outputDirectory, "manifest.json"), "utf8"));
    if (!isRecord(value) || typeof value.mainSha !== "string" || !/^[a-f0-9]{40,64}$/.test(value.mainSha) ||
        typeof value.headSha !== "string" || !/^[a-f0-9]{40,64}$/.test(value.headSha) ||
        !Array.isArray(value.artifacts) || !Array.isArray(value.deleted)) {
        throw new Error("Invalid regression manifest.");
    }
    const definition = (entry: unknown): Definition => {
        if (!isRecord(entry) || typeof entry.path !== "string" || !kindOf(entry.path) || kindOf(entry.path) !== entry.kind) {
            throw new Error("Invalid artifact in regression manifest.");
        }
        validatePath(entry.path);
        const kind = kindOf(entry.path);
        if (!kind) throw new Error("Unsupported artifact in regression manifest.");
        return { path: entry.path, kind };
    };
    const artifacts = value.artifacts.map((entry: unknown): Artifact => {
        const artifact = definition(entry);
        if (!isRecord(entry) || (entry.mainPath !== null && typeof entry.mainPath !== "string")) {
            throw new Error("Invalid baseline artifact in regression manifest.");
        }
        if (typeof entry.mainPath === "string") {
            validatePath(entry.mainPath);
            if (kindOf(entry.mainPath) !== artifact.kind) throw new Error("Mismatched baseline artifact kind.");
        }
        return { ...artifact, mainPath: entry.mainPath };
    });
    if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
        throw new Error("Duplicate artifacts in regression manifest.");
    }
    return { mainSha: value.mainSha, headSha: value.headSha, artifacts, deleted: value.deleted.map(definition) };
}

function clearEvidence(outputDirectory: string) {
    for (const file of ["main.jsonl", "main.stderr.txt", "candidate.jsonl", "candidate.stderr.txt", "comparison.json", "error.txt"]) {
        const target = path.join(outputDirectory, file);
        if (fs.existsSync(target)) fs.unlinkSync(target);
    }
}

export function writeManifest(manifest: Manifest, outputDirectory: string) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    clearEvidence(outputDirectory);
    fs.writeFileSync(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(outputDirectory, "summary.md"), renderSummary(manifest, []));
}

const runEvaluator: Evaluator = (targets, directory) => spawnSync(process.execPath, [
    "--import", "tsx", path.join(directory, "cli.ts"), "evaluate", "--files", ...targets, "--json",
], { cwd: directory, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });

export function evaluateRegression(
    manifest: Manifest,
    mainDirectory: string,
    candidateDirectory: string,
    outputDirectory: string,
    evaluator: Evaluator = runEvaluator,
): Comparison[] {
    fs.mkdirSync(outputDirectory, { recursive: true });
    clearEvidence(outputDirectory);
    const evaluatorDirectory = path.join(mainDirectory, "evaluator");
    try {
        if (git(mainDirectory, ["rev-parse", "HEAD"]).trim() !== manifest.mainSha ||
            git(candidateDirectory, ["rev-parse", "HEAD"]).trim() !== manifest.headSha) {
            throw new Error("Evaluation snapshots do not match the manifest's pinned commit SHAs.");
        }
        const evaluate = (side: string, files: string[], snapshotDirectory: string) => {
            if (!files.length) {
                fs.writeFileSync(path.join(outputDirectory, `${side}.jsonl`), "");
                fs.writeFileSync(path.join(outputDirectory, `${side}.stderr.txt`), "");
                return new Map<string, Result>();
            }
            const targets = files.map((file) => {
                const target = path.resolve(snapshotDirectory, file.endsWith("/SKILL.md") ? path.posix.dirname(file) : file);
                if (target.includes(",")) throw new Error(`The evaluator CLI cannot accept a target containing commas: ${JSON.stringify(file)}`);
                return target;
            });
            const result = evaluator(targets, evaluatorDirectory);
            fs.writeFileSync(path.join(outputDirectory, `${side}.jsonl`), result.stdout);
            fs.writeFileSync(path.join(outputDirectory, `${side}.stderr.txt`), result.stderr);
            if (result.error) throw new Error(`${side} evaluator failed: ${result.error.message}`, { cause: result.error });
            if (result.status !== 0) {
                throw new Error(`${side} evaluator exited with ${result.signal ?? result.status}. See ${side}.stderr.txt.`);
            }
            return parseResults(result.stdout, files, snapshotDirectory, evaluatorDirectory);
        };
        const mainFiles = [...new Set(manifest.artifacts.flatMap((artifact) => artifact.mainPath === null ? [] : [artifact.mainPath]))];
        const main = evaluate("main", mainFiles, mainDirectory);
        const candidate = evaluate("candidate", manifest.artifacts.map((artifact) => artifact.path), candidateDirectory);
        const comparisons = compareResults(manifest.artifacts, main, candidate);
        fs.writeFileSync(path.join(outputDirectory, "comparison.json"), `${JSON.stringify({
            mainSha: manifest.mainSha, headSha: manifest.headSha, comparisons, deleted: manifest.deleted,
        }, null, 2)}\n`);
        fs.writeFileSync(path.join(outputDirectory, "summary.md"), renderSummary(manifest, comparisons));
        return comparisons;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fs.writeFileSync(path.join(outputDirectory, "error.txt"), `${message}\n`);
        fs.writeFileSync(path.join(outputDirectory, "summary.md"), renderSummary(manifest, [], message));
        throw error;
    }
}

async function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            repository: { type: "string" },
            "main-ref": { type: "string" },
            "head-ref": { type: "string" },
            "main-directory": { type: "string" },
            "candidate-directory": { type: "string" },
            output: { type: "string" },
        },
    });
    const required = (name: keyof typeof values): string => {
        const value = values[name];
        if (!value) throw new Error(`Missing required --${name} argument.`);
        return value;
    };
    const outputDirectory = path.resolve(required("output"));
    if (positionals.length !== 1) throw new Error("Use the discover or evaluate regression command.");
    if (positionals[0] === "discover") {
        const manifest = discover(path.resolve(required("repository")), required("main-ref"), required("head-ref"));
        writeManifest(manifest, outputDirectory);
        console.log(`Selected ${manifest.artifacts.length} artifact(s); excluded ${manifest.deleted.length} deletion(s).`);
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_artifacts=${manifest.artifacts.length > 0}\n`);
        }
    } else if (positionals[0] === "evaluate") {
        const comparisons = evaluateRegression(readManifest(outputDirectory),
            path.resolve(required("main-directory")), path.resolve(required("candidate-directory")), outputDirectory);
        const regressions = comparisons.filter((comparison) => comparison.regression);
        for (const regression of regressions) {
            const file = escapeAnnotation(regression.path).replace(/:/g, "%3A").replace(/,/g, "%2C");
            console.error(`::error file=${file}::${escapeAnnotation(`Score dropped from ${regression.mainScore} to ${regression.score} (more than 1 point). ${regression.reasoning}`)}`);
        }
        console.log(`Compared ${comparisons.length} artifact(s); ${regressions.length} regression(s).`);
        if (regressions.length) process.exitCode = 1;
    } else {
        throw new Error(`Unknown regression command: ${positionals[0]}`);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`::error::${escapeAnnotation(message)}`);
        process.exitCode = 1;
    });
}
