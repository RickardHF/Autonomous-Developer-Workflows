import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const evaluatorDirectory = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(evaluatorDirectory, "cli.ts");

function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
        cwd: evaluatorDirectory,
        encoding: "utf-8",
    });
}

function runMockedCli(args: string[]) {
    const script = `
import { mock } from "node:test";
mock.module("@github/copilot-sdk", { namedExports: {
    defineTool: (name, options) => ({ name, ...options }),
    CopilotClient: class {
        async start() {}
        async stop() {}
        async createSession() {
            return { sendAndWait: async (prompt) => {
                const check = prompt.match(/<skill-folder-check>\\s*([\\s\\S]*?)\\s*<\\/skill-folder-check>/);
                if (!check?.[1]) throw new Error("Missing skill folder context.");
                return { data: { toolRequests: [{
                    name: "evaluate", arguments: { score: 6, reasoning: check[1].trim() }
                }] } };
            } };
        }
    }
} });
process.argv = ${JSON.stringify([process.execPath, ...args])};
await import(${JSON.stringify(cliPath)});
`;
    return spawnSync(process.execPath, ["--import", "tsx", "--experimental-test-module-mocks",
        "--input-type=module", "--eval", script], {
        cwd: evaluatorDirectory,
        encoding: "utf-8",
    });
}

for (const mode of ["explicit", "automatic"] as const) {
    test(`${mode} evaluation emits score-1 JSONL results for invalid frontmatter`, () => {
        const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-frontmatter-"));
        const agentFile = path.join(fixtureDirectory, ".github", "agents", "example.agent.md");
        const skillDirectory = path.join(fixtureDirectory, ".agents", "skills", "example");
        fs.mkdirSync(path.dirname(agentFile), { recursive: true });
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(agentFile, "# No frontmatter\n");
        fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), "---\nname: example\n---\nInstructions\n");

        try {
            const args = mode === "explicit" ? ["--files", agentFile, skillDirectory] : ["--directory", fixtureDirectory];
            const result = runCli(["evaluate", ...args, "--json"]);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, "");
            const results = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
            assert.equal(results.length, 2);
            for (const entry of results) {
                assert.equal(entry.score, 1);
                assert.match(entry.reasoning, /Invalid frontmatter/);
            }
            const relativeTo = mode === "explicit" ? evaluatorDirectory : fixtureDirectory;
            assert.deepEqual(results.map((entry) => entry.fileName).sort(), [
                path.relative(relativeTo, agentFile),
                path.relative(relativeTo, path.join(skillDirectory, "SKILL.md")),
            ].sort());
        } finally {
            fs.rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    test(`${mode} evaluation passes the actual skill folder and preserves AI-scored mismatches`, () => {
        const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-folder-"));
        const skillDirectory = path.join(fixtureDirectory, ".agents", "skills", "actual-folder");
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(path.join(skillDirectory, "SKILL.md"),
            "---\nname: different-name\ndescription: Performs a specific task.\n---\nInstructions\n");

        try {
            const args = mode === "explicit" ? ["--files", skillDirectory] : ["--directory", fixtureDirectory];
            const result = runMockedCli(["evaluate", ...args, "--json"]);
            assert.equal(result.status, 0, result.stderr);
            const entry = JSON.parse(result.stdout.trim());
            assert.equal(entry.score, 6);
            assert.deepEqual(JSON.parse(entry.reasoning), {
                checked: true, folderName: "actual-folder", name: "different-name", nameMatchesFolder: false,
            });
        } finally {
            fs.rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });
}

test("JSON mode reserves stdout for evaluation results", () => {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-json-"));
    fs.mkdirSync(path.join(fixtureDirectory, ".agents", "skills", "missing"), { recursive: true });

    try {
        const result = runCli(["evaluate", "--directory", fixtureDirectory, "--json"]);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /SKILL\.md not found in skill directory:/);
    } finally {
        fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
});

test("normal mode retains discovery output", () => {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-text-"));
    fs.mkdirSync(path.join(fixtureDirectory, ".agents", "skills", "missing"), { recursive: true });

    try {
        const result = runCli(["evaluate", "--directory", fixtureDirectory]);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /No files specified, searching for files matching the pattern/);
        assert.match(result.stdout, /Found skill directory:/);
        assert.match(result.stdout, /SKILL\.md not found in skill directory:/);
        assert.equal(result.stderr, "");
    } finally {
        fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
});

test("JSON mode rejects explicit-file inputs that do not match the contract", () => {
    const result = runCli(["evaluate", "--files", "example.agent.md", "--json"]);

    assert.notEqual(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Invalid evaluation inputs|No valid agent files/);
});

test("explicit --files accepts comma-delimited values in a single argument", () => {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-comma-"));
    const validAgent = path.join(fixtureDirectory, "valid.agent.md");
    const validSkill = path.join(fixtureDirectory, "valid-skill");

    fs.writeFileSync(validAgent, "# valid agent\n");
    fs.mkdirSync(validSkill, { recursive: true });
    fs.writeFileSync(path.join(validSkill, "SKILL.md"), "# valid skill\n");

    try {
        const value = `${validAgent}, ${validSkill}`;
        const result = runCli(["evaluate", "--files", value, "--json"]);

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(result.stdout.trim().split(/\n/).length, 2);
    } finally {
        fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
});

test("explicit --files accepts repo paths without the leading dot on .agents directories", () => {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-dotless-"));
    const validAgent = path.join(fixtureDirectory, ".agents", "agents", "valid.agent.md");
    const validSkill = path.join(fixtureDirectory, ".agents", "skills", "valid-skill");

    fs.mkdirSync(path.dirname(validAgent), { recursive: true });
    fs.writeFileSync(validAgent, "# valid agent\n");
    fs.mkdirSync(validSkill, { recursive: true });
    fs.writeFileSync(path.join(validSkill, "SKILL.md"), "# valid skill\n");

    try {
        const dotlessAgent = path.join(fixtureDirectory, "agents", "agents", "valid.agent.md");
        const dotlessSkill = path.join(fixtureDirectory, "agents", "skills", "valid-skill");
        const result = runCli(["evaluate", "--files", dotlessAgent, dotlessSkill, "--json"]);

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(result.stdout.trim().split(/\n/).length, 2);
    } finally {
        fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
});

test("explicit --files accepts the repo's real relative paths without hidden-directory prefixes", () => {
    const result = runCli([
        "evaluate",
        "--files",
        "../.github/agents/csharper.agent.md",
        "../agents/skills/generic-skill-name",
        "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\{.*"fileName".*\}/);
});

test("explicit --files rejects invalid entries before evaluation", () => {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-invalid-"));
    const validAgent = path.join(fixtureDirectory, "valid.agent.md");
    const validSkill = path.join(fixtureDirectory, "valid-skill");

    fs.writeFileSync(validAgent, "# valid agent\n");
    fs.mkdirSync(validSkill, { recursive: true });
    fs.writeFileSync(path.join(validSkill, "SKILL.md"), "# valid skill\n");

    const missingAgent = path.join(fixtureDirectory, "missing.agent.md");
    const missingSkill = path.join(fixtureDirectory, "missing-skill");
    const invalidFile = path.join(fixtureDirectory, "notes.txt");
    fs.writeFileSync(invalidFile, "not a valid input\n");

    try {
        const result = runCli([
            "evaluate",
            "--files",
            missingAgent,
            missingSkill,
            invalidFile,
            validAgent,
            validSkill,
            "--json",
        ]);

        assert.notEqual(result.status, 0, result.stdout || result.stderr);
        assert.match(result.stderr, /Invalid evaluation inputs|No valid agent files|SKILL\.md/);
    } finally {
        fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
});