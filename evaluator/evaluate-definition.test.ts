import assert from "node:assert/strict";
import path from "node:path";
import test, { mock } from "node:test";

const qualityResult = { score: 8, reasoning: "Mocked quality evaluation." };
const requests: { systemMessage: string; prompt: string }[] = [];
let clientInstances = 0;
let clientStarts = 0;
let clientStops = 0;

mock.module("@github/copilot-sdk", {
    namedExports: {
        defineTool: (name: string, options: object) => ({ name, ...options }),
        CopilotClient: class {
            constructor() {
                clientInstances++;
            }
            async start() {
                clientStarts++;
            }
            async stop() {
                clientStops++;
            }
            async createSession(options: { systemMessage: { content: string } }) {
                return {
                    sendAndWait: async (prompt: string) => {
                        requests.push({ systemMessage: options.systemMessage.content, prompt });
                        return { data: { toolRequests: [{ name: "evaluate", arguments: qualityResult }] } };
                    },
                };
            }
        },
    },
});

const { evaluateAgentDefinition, evaluateSkillDefinition, evaluatePerformance } = await import("./evaluate.js");

function definition(frontmatter = "name: example\ndescription: Performs a specific task.") {
    return `---\n${frontmatter}\n---\n\n# Instructions\nPerform the task and report the result.\n`;
}

function lastRequest() {
    const request = requests.at(-1);
    assert.ok(request, "Expected an SDK evaluation request");
    return request;
}

function folderCheck(prompt: string) {
    const match = prompt.match(/<skill-folder-check>\s*([\s\S]*?)\s*<\/skill-folder-check>/);
    assert.ok(match?.[1], "Expected programmatic folder check in the prompt");
    return JSON.parse(match[1]);
}

const invalidDefinitions: { name: string; content: string; reason: RegExp }[] = [
    { name: "empty definition", content: "", reason: /start.*---/ },
    { name: "missing frontmatter", content: "# Instructions\nPerform a task.", reason: /start.*---/ },
    { name: "content before frontmatter", content: `# Heading\n${definition()}`, reason: /start.*---/ },
    { name: "blank line before frontmatter", content: `\n${definition()}`, reason: /start.*---/ },
    { name: "opening delimiter with extra text", content: definition().replace(/^---/, "--- yaml"), reason: /start.*---/ },
    { name: "missing closing delimiter", content: "---\nname: example\ndescription: A task.", reason: /closing.*---/ },
    { name: "non-standalone closing delimiter", content: "---\nname: example\ndescription: A task.\n--- end", reason: /closing.*---/ },
    { name: "alternative closing delimiter", content: "---\nname: example\ndescription: A task.\n...", reason: /closing.*---/ },
    { name: "malformed YAML sequence", content: definition("name: example\ndescription: [unfinished"), reason: /Invalid YAML/ },
    { name: "malformed YAML mapping", content: definition("name: example\ndescription: A task: invalid"), reason: /Invalid YAML/ },
    { name: "duplicate fields", content: definition("name: example\ndescription: First\ndescription: Second"), reason: /Invalid YAML.*unique/s },
    { name: "unresolved YAML alias", content: definition("name: example\ndescription: *missing"), reason: /Invalid YAML.*alias/s },
    { name: "empty frontmatter", content: "---\n---\nInstructions", reason: /mapping/ },
    { name: "scalar frontmatter", content: definition("plain text"), reason: /mapping/ },
    { name: "sequence frontmatter", content: definition("- name: example\n- description: A task."), reason: /mapping/ },
    { name: "null frontmatter", content: definition("null"), reason: /mapping/ },
];

for (const [kind, evaluate] of [
    ["agent", evaluateAgentDefinition],
    ["skill", evaluateSkillDefinition],
] as const) {
    for (const fixture of invalidDefinitions) {
        test(`${kind} validation rejects ${fixture.name} without creating a Copilot client`, async () => {
            const instancesBefore = clientInstances;
            const startsBefore = clientStarts;
            const requestsBefore = requests.length;
            const result = await evaluate(fixture.content);

            assert.equal(result.score, 1);
            assert.match(result.reasoning, fixture.reason);
            assert.ok(result.reasoning.length > 0 && result.reasoning.length <= 500);
            assert.equal(clientInstances, instancesBefore);
            assert.equal(clientStarts, startsBefore);
            assert.equal(requests.length, requestsBefore);
        });
    }
}

for (const [kind, evaluate, fields] of [
    ["agent", evaluateAgentDefinition, ["description"]],
    ["skill", evaluateSkillDefinition, ["name", "description"]],
] as const) {
    for (const field of fields) {
        for (const value of [undefined, "", "null", '""', '"   "', "42", "false", "[]", "{}"]) {
            test(`${kind} validation requires a nonempty string ${field}: ${value ?? "missing"}`, async () => {
                const frontmatter = [
                    field === "name" ? (value === undefined ? "" : `name: ${value}`) : "name: example",
                    field === "description" ? (value === undefined ? "" : `description: ${value}`) : "description: A task.",
                ].filter(Boolean).join("\n");
                const instancesBefore = clientInstances;
                const result = await evaluate(definition(frontmatter));

                assert.equal(result.score, 1);
                assert.match(result.reasoning, new RegExp(`nonempty strings:.*${field}`));
                assert.equal(clientInstances, instancesBefore);
            });
        }
    }
}

test("missing skill name and description are both reported", async () => {
    const result = await evaluateSkillDefinition(definition("license: MIT"));
    assert.equal(result.score, 1);
    assert.match(result.reasoning, /name, description/);
});

test("validation diagnostics stay within the reasoning limit", async () => {
    const result = await evaluateAgentDefinition(definition(`description: [${"x".repeat(1000)}`));
    assert.equal(result.score, 1);
    assert.match(result.reasoning, /Invalid YAML/);
    assert.ok(result.reasoning.length <= 500);
});

for (const [kind, evaluate] of [
    ["agent", evaluateAgentDefinition],
    ["skill", evaluateSkillDefinition],
] as const) {
    for (const [format, content] of [
        ["LF", definition()],
        ["CRLF", definition().replace(/\n/g, "\r\n")],
        ["BOM", `\uFEFF${definition()}`],
        ["BOM and CRLF", `\uFEFF${definition().replace(/\n/g, "\r\n")}`],
        ["multiline description", definition("name: example\ndescription: >\n  Performs a specific task.\n  Use for that task.")],
        ["YAML alias", definition("name: example\nabout: &about A specific task.\ndescription: *about")],
        ["optional metadata", definition("name: example\ndescription: A task.\nmetadata:\n  author: Someone\nuser-invocable: false")],
    ] as const) {
        test(`${kind} validation accepts ${format} and preserves AI scoring`, async () => {
            const instancesBefore = clientInstances;
            const stopsBefore = clientStops;
            assert.deepEqual(await evaluate(content), qualityResult);
            assert.equal(clientInstances, instancesBefore + 1);
            assert.equal(clientStops, stopsBefore + 1);
            assert.ok(lastRequest().prompt.includes(content));
        });
    }
}

test("agent name, model, and tools are optional", async () => {
    assert.deepEqual(await evaluateAgentDefinition(definition("description: Performs a specific task.")), qualityResult);
});

test("agent rubric evaluates model sizing, tool coverage, and least privilege in context", async () => {
    const content = definition("description: Reviews code without editing.\nmodel: example-model\ntools: ['read', 'search']");
    assert.deepEqual(await evaluateAgentDefinition(content), qualityResult);

    const { systemMessage, prompt } = lastRequest();
    assert.match(systemMessage, /underpowered and overpowered/);
    assert.match(systemMessage, /omitted model inherits/i);
    assert.match(systemMessage, /do not penalize omission alone/);
    assert.match(systemMessage, /Tool coverage and least privilege/);
    assert.match(systemMessage, /missing capabilities and excessive access/);
    assert.match(systemMessage, /Omitted tools or a wildcard allow all/);
    assert.match(systemMessage, /empty list allows none/);
    assert.match(systemMessage, /Shell\/execute tools can modify files/);
    assert.match(systemMessage, /client-specific aliases/);
    assert.match(systemMessage, /Explain concrete model or tool mismatches/);
    assert.ok(prompt.includes(content));
});

test("skill rubric evaluates metadata against instructions, artifacts, and trigger boundaries", async () => {
    const artifacts = [{ path: ".hidden/context.md", content: "Specific task support." }];
    assert.deepEqual(await evaluateSkillDefinition(definition(), artifacts), qualityResult);

    const { systemMessage, prompt } = lastRequest();
    assert.match(systemMessage, /Name suitability/);
    assert.match(systemMessage, /Description suitability/);
    assert.match(systemMessage, /trigger boundaries.*instructions and supporting artifacts/);
    assert.match(systemMessage, /vague, misleading, overly broad, or overly narrow/);
    assert.match(prompt, /<artifact path="\.hidden\/context\.md">Specific task support\.<\/artifact>/);
});

test("skill folder context detects an exact match with a trailing directory separator", async () => {
    assert.deepEqual(await evaluateSkillDefinition(definition(), undefined, `example${path.sep}`), qualityResult);
    assert.deepEqual(folderCheck(lastRequest().prompt), {
        checked: true, folderName: "example", name: "example", nameMatchesFolder: true,
    });
});

test("skill folder mismatches are AI-scored instead of automatically receiving 1", async () => {
    assert.deepEqual(await evaluateSkillDefinition(definition(), [], path.join("skills", "different")), qualityResult);
    const { systemMessage, prompt } = lastRequest();
    assert.deepEqual(folderCheck(prompt), {
        checked: true, folderName: "different", name: "example", nameMatchesFolder: false,
    });
    assert.match(systemMessage, /reduce the quality score and explain the mismatch/);
    assert.match(systemMessage, /not an automatic score of 1/);
    assert.match(systemMessage, /do not apply a fixed numeric penalty/);
});

test("skill folder-name comparison is case-sensitive", async () => {
    await evaluateSkillDefinition(definition(), [], "Example");
    assert.equal(folderCheck(lastRequest().prompt).nameMatchesFolder, false);
});

test("content-only skill API calls do not claim to verify folder matching", async () => {
    assert.deepEqual(await evaluateSkillDefinition(definition()), qualityResult);
    assert.deepEqual(folderCheck(lastRequest().prompt), { checked: false });
    assert.match(lastRequest().systemMessage, /do not infer a folder name or claim it was verified/);
});

test("performance evaluation remains independent of definition validation and rubrics", async () => {
    assert.deepEqual(await evaluatePerformance("A plain task", "Plain output", "Plain expectations"), qualityResult);
    const { systemMessage, prompt } = lastRequest();
    assert.doesNotMatch(systemMessage, /agent-definition-criteria|skill-definition-criteria/);
    assert.doesNotMatch(prompt, /skill-folder-check/);
    assert.match(prompt, /<user-prompt>\nA plain task\n<\/user-prompt>/);
    assert.match(prompt, /<process-output>\nPlain output\n<\/process-output>/);
    assert.match(prompt, /<expectations>\nPlain expectations\n<\/expectations>/);
});
