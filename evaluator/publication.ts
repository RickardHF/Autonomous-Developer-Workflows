import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { generateBadgeSvg } from "./badge.js";
import { discoverDefinitions } from "./discovery.js";
import { escapeAnnotation, parseResults } from "./regression.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repositoryName = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const positiveInteger = z.number().int().positive().safe();
const snapshotSchema = z.object({
    version: z.literal(1),
    repository: repositoryName,
    sourceSha: sha,
    sourceRef: z.string().min(1),
    runId: positiveInteger,
    runAttempt: positiveInteger,
    evaluatedAt: z.iso.datetime(),
    files: z.array(z.string().min(1)).min(1),
    results: z.array(z.object({
        fileName: z.string().min(1),
        score: z.number().min(1).max(10),
        reasoning: z.string().refine((value) => value.trim().length > 0),
    })).min(1),
    svg: z.string().min(1),
});
export type EvaluationSnapshot = z.infer<typeof snapshotSchema>;
type Identity = Pick<EvaluationSnapshot, "repository" | "sourceSha" | "sourceRef" | "runId" | "runAttempt">;
const runSchema = z.object({
    id: positiveInteger,
    run_attempt: positiveInteger,
    head_sha: sha,
    head_branch: z.string().nullable(),
    head_repository: z.object({ full_name: repositoryName }).nullable(),
    event: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
});
type EvaluationRun = z.infer<typeof runSchema>;
type PublicationServices = {
    api: (route: string) => unknown;
    download: (artifactId: number) => unknown;
    fetch: typeof fetch;
    log: (message: string) => void;
};

function git(directory: string, ...args: string[]) {
    return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

function jsonl(results: EvaluationSnapshot["results"]) {
    return `${results.map((result) => JSON.stringify(result)).join("\n")}\n`;
}

function badgeDate(snapshot: Pick<EvaluationSnapshot, "evaluatedAt" | "sourceSha">) {
    return `${snapshot.evaluatedAt.slice(0, 10)} ${snapshot.sourceSha.slice(0, 12)}`;
}

export function validateSnapshot(value: unknown, repository: string): EvaluationSnapshot {
    const snapshot = snapshotSchema.parse(value);
    if (snapshot.repository !== repository) throw new Error("Evaluation belongs to another repository.");
    if (new Set(snapshot.files).size !== snapshot.files.length) throw new Error("Duplicate expected evaluation definitions.");
    for (const file of snapshot.files) {
        if (path.posix.normalize(file) !== file || /[\x00-\x1f\\]/.test(file) ||
            !/^\.(?:github|agents)\/(?:agents\/[^/]+\.agent\.md|skills\/[^/]+\/SKILL\.md)$/.test(file)) {
            throw new Error(`Invalid evaluated definition path: ${JSON.stringify(file)}`);
        }
    }
    parseResults(jsonl(snapshot.results), snapshot.files, path.resolve("/evaluation"), path.resolve("/evaluation"));
    if (snapshot.svg !== generateBadgeSvg(snapshot.results, badgeDate(snapshot))) {
        throw new Error("SVG does not match the complete evaluation results and source revision.");
    }
    return snapshot;
}

export async function createSnapshot(
    directory: string,
    input: string,
    identity: Identity,
    evaluatedAt = new Date().toISOString(),
): Promise<EvaluationSnapshot> {
    if (git(directory, "rev-parse", "HEAD") !== identity.sourceSha) {
        throw new Error("Evaluation source does not match the checked-out commit.");
    }
    const { agentFiles, skillDirectories } = await discoverDefinitions(directory);
    const files = [...agentFiles, ...skillDirectories.map((skill) => path.join(skill, "SKILL.md"))
        .filter((file) => fs.existsSync(file))]
        .map((file) => path.relative(directory, file).split(path.sep).join("/")).sort();
    if (!files.length) throw new Error("No definitions were discovered; refusing to publish an empty evaluation.");
    const results = [...parseResults(fs.readFileSync(input, "utf8"), files, directory, directory).values()]
        .sort((a, b) => a.fileName.localeCompare(b.fileName));
    return validateSnapshot({
        version: 1, ...identity, evaluatedAt, files, results,
        svg: generateBadgeSvg(results, badgeDate({ evaluatedAt, sourceSha: identity.sourceSha })),
    }, identity.repository);
}

export function writeSnapshot(snapshot: EvaluationSnapshot, directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, "results.jsonl"), jsonl(snapshot.results));
    fs.writeFileSync(path.join(directory, "eval-badge.svg"), snapshot.svg);
}

export function newerSnapshot(
    current: EvaluationSnapshot | null,
    candidate: EvaluationSnapshot,
    history: string[],
) {
    const candidateRank = history.indexOf(candidate.sourceSha);
    if (candidate.sourceRef !== "refs/heads/main" || candidateRank < 0) {
        throw new Error("Evaluation is not from an ancestor of the captured main revision.");
    }
    if (!current) return candidate;
    const currentRank = history.indexOf(current.sourceSha);
    if (current.sourceRef !== "refs/heads/main" || currentRank < 0) {
        throw new Error("Published evaluation is not from the current main history.");
    }
    if (candidateRank !== currentRank) return candidateRank < currentRank ? candidate : current;
    if (candidate.runId !== current.runId) return candidate.runId > current.runId ? candidate : current;
    return candidate.runAttempt > current.runAttempt ? candidate : current;
}

function ghApi(route: string): unknown {
    return JSON.parse(execFileSync("gh", ["api", route], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

function downloadSnapshot(repository: string, artifactId: number): unknown {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "evaluation-artifact-"));
    try {
        const archive = path.join(directory, "evaluation.zip");
        fs.writeFileSync(archive, execFileSync("gh", [
            "api", `repos/${repository}/actions/artifacts/${artifactId}/zip`,
        ], { maxBuffer: 32 * 1024 * 1024 }));
        // Read one fixed member; never extract arbitrary artifact paths into the checkout.
        return JSON.parse(execFileSync("unzip", ["-p", archive, "snapshot.json"], {
            encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        }));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

export async function stagePages(
    directory: string,
    output: string,
    repository: string,
    pagesUrl: string,
    gameDirectory: string,
    services: PublicationServices = {
        api: ghApi, download: (id) => downloadSnapshot(repository, id), fetch, log: console.log,
    },
): Promise<EvaluationSnapshot | null> {
    repositoryName.parse(repository);
    if (fs.existsSync(output)) throw new Error("Pages staging directory must be fresh.");
    const gameBuild = path.resolve(gameDirectory);
    const resolvedOutput = path.resolve(output);
    const relativeOutput = path.relative(gameBuild, resolvedOutput);
    if (relativeOutput !== "" && !relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput)) {
        throw new Error("Pages staging directory must be outside the game build.");
    }
    const entry = fs.statSync(path.join(gameBuild, "index.html"), { throwIfNoEntry: false });
    if (!entry?.isFile() || entry.size === 0) throw new Error("Game build must contain a nonempty index.html.");
    if (fs.existsSync(path.join(gameBuild, "evaluation"))) {
        throw new Error("Game build must not contain the reserved evaluation directory.");
    }
    const base = new URL(`${pagesUrl.replace(/\/$/, "")}/`);
    if (base.protocol !== "https:") throw new Error("Pages URL must use HTTPS.");
    const history = git(directory, "rev-list", "HEAD").split("\n");
    const previousUrl = new URL("evaluation/snapshot.json", base);
    previousUrl.searchParams.set("publication", `${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`);
    const response = await services.fetch(previousUrl, { headers: { "Cache-Control": "no-cache" } });
    let selected: EvaluationSnapshot | null = null;
    if (response.status === 404) {
        services.log("::notice::No previously published evaluation snapshot; looking for a complete main evaluation.");
    } else {
        if (!response.ok) throw new Error(`Cannot read published evaluation: HTTP ${response.status}.`);
        selected = validateSnapshot(await response.json(), repository);
        newerSnapshot(null, selected, history);
    }

    const runs: EvaluationRun[] = [];
    for (let page = 1; ; page++) {
        const value = z.object({
            total_count: z.number().int().nonnegative(),
            workflow_runs: z.array(runSchema),
        }).parse(services.api(`repos/${repository}/actions/workflows/evaluate.yml/runs?branch=main&status=success&per_page=100&page=${page}`));
        runs.push(...value.workflow_runs.filter((run) =>
            run.head_repository?.full_name === repository && run.head_branch === "main" &&
            ["push", "workflow_dispatch"].includes(run.event) && run.status === "completed" &&
            run.conclusion === "success" && history.includes(run.head_sha)));
        if (!value.workflow_runs.length || page * 100 >= value.total_count) break;
    }
    runs.sort((a, b) => history.indexOf(a.head_sha) - history.indexOf(b.head_sha) ||
        b.id - a.id || b.run_attempt - a.run_attempt);
    for (const run of runs) {
        if (selected && (history.indexOf(run.head_sha) > history.indexOf(selected.sourceSha) ||
            (run.head_sha === selected.sourceSha &&
                (run.id < selected.runId || (run.id === selected.runId && run.run_attempt <= selected.runAttempt))))) {
            break;
        }
        const artifacts = z.object({ artifacts: z.array(z.object({
            id: positiveInteger, name: z.string(), expired: z.boolean(),
        })) }).parse(services.api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`));
        const bundles = artifacts.artifacts.filter((artifact) => artifact.name === "evaluation-output" && !artifact.expired);
        if (!bundles.length) {
            services.log(`::notice::Run ${run.id} has no available complete bundle (legacy output or expired artifact).`);
            continue;
        }
        if (bundles.length !== 1) throw new Error(`Run ${run.id} has ambiguous evaluation bundles.`);
        const snapshot = validateSnapshot(services.download(bundles[0]!.id), repository);
        if (snapshot.sourceSha !== run.head_sha || snapshot.runId !== run.id || snapshot.runAttempt !== run.run_attempt) {
            throw new Error(`Evaluation bundle does not match run ${run.id}.`);
        }
        selected = newerSnapshot(selected, snapshot, history);
        break;
    }

    fs.cpSync(gameBuild, output, { recursive: true });
    fs.writeFileSync(path.join(output, ".nojekyll"), "");
    const evaluationDirectory = path.join(output, "evaluation");
    if (selected) {
        writeSnapshot(selected, evaluationDirectory);
        services.log(`Site source: ${history[0]}. Latest complete evaluation: ${selected.sourceSha} (run ${selected.runId}, attempt ${selected.runAttempt}).`);
    } else {
        fs.mkdirSync(evaluationDirectory, { recursive: true });
        fs.writeFileSync(path.join(evaluationDirectory, "eval-badge.svg"),
            '<svg xmlns="http://www.w3.org/2000/svg" width="620" height="64" role="img" aria-label="No complete evaluation published yet"><rect width="620" height="64" rx="8" fill="#1e2433"/><text x="20" y="38" fill="#c9d1d9" font-family="sans-serif">No complete evaluation published yet</text></svg>\n');
        services.log("::warning::No complete evaluation is available. Staged the game with an explicit pending-evaluation image.");
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            `## Game and evaluation publication\n\nSite source: \`${history[0]}\`.\n\n` +
            (selected ? `Latest complete evaluation: \`${selected.sourceSha}\` ([run](${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${selected.runId})).\n\n`
                : "**No complete evaluation published yet.**\n\n") +
            `[View SVG](${new URL("evaluation/eval-badge.svg", base)}) | [Play game](${base})\n`);
    }
    return selected;
}

async function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            directory: { type: "string" }, input: { type: "string" },
            output: { type: "string" }, "pages-url": { type: "string" }, "game-directory": { type: "string" },
        },
    });
    const required = (name: keyof typeof values) => {
        const value = values[name];
        if (!value) throw new Error(`Missing --${name}.`);
        return value;
    };
    const repository = repositoryName.parse(process.env.GITHUB_REPOSITORY);
    const directory = path.resolve(required("directory"));
    const output = path.resolve(required("output"));
    if (positionals.length !== 1) throw new Error("Use bundle or stage.");
    if (positionals[0] === "bundle") {
        if (fs.existsSync(output)) throw new Error("Evaluation output directory must be fresh.");
        const snapshot = await createSnapshot(directory, path.resolve(required("input")), {
            repository,
            sourceSha: sha.parse(process.env.GITHUB_SHA),
            sourceRef: z.string().min(1).parse(process.env.GITHUB_REF),
            runId: positiveInteger.parse(Number(process.env.GITHUB_RUN_ID)),
            runAttempt: positiveInteger.parse(Number(process.env.GITHUB_RUN_ATTEMPT)),
        });
        writeSnapshot(snapshot, output);
        console.log(`Complete evaluation: ${snapshot.results.length} definitions at ${snapshot.sourceSha}.`);
    } else if (positionals[0] === "stage") {
        await stagePages(directory, output, repository, required("pages-url"), path.resolve(required("game-directory")));
    } else {
        throw new Error("Use bundle or stage.");
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((error: unknown) => {
        console.error(`::error::${escapeAnnotation(error instanceof Error ? error.message : String(error))}`);
        process.exitCode = 1;
    });
}
