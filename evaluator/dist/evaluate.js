import { z } from "zod";
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { isMap, parseDocument } from "yaml";
import path from "node:path";
const maxEvaluationAttempts = 3;
function isEvalFailure(error) {
    return error instanceof Error && error.cause === "eval_failure";
}
const EvalSchema = z.object({
    score: z.number().min(1).max(10).describe("The score of the evaluation, must be between 1 and 10."),
    reasoning: z.string().min(1).max(500).describe("The reasoning and justification behind the evaluation, must be between 1 and 500 characters."),
});
function validateFrontmatter(definition, requiredFields) {
    const fail = (reasoning) => ({
        failure: { score: 1, reasoning: reasoning.slice(0, 500) },
    });
    const lines = definition.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines[0] !== "---") {
        return fail("Invalid frontmatter: the definition must start with a standalone --- delimiter.");
    }
    const closingDelimiter = lines.indexOf("---", 1);
    if (closingDelimiter === -1) {
        return fail("Invalid frontmatter: missing a standalone closing --- delimiter.");
    }
    const document = parseDocument(lines.slice(1, closingDelimiter).join("\n"));
    if (document.errors.length > 0) {
        return fail(`Invalid YAML frontmatter: ${document.errors[0]?.message}`);
    }
    if (!isMap(document.contents)) {
        return fail("Invalid frontmatter: YAML must be a mapping of field names to values.");
    }
    let value;
    try {
        value = document.toJS();
    }
    catch (error) {
        return fail(`Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    }
    const metadata = z.record(z.string(), z.unknown()).safeParse(value);
    if (!metadata.success) {
        return fail("Invalid frontmatter: YAML must be a mapping of field names to values.");
    }
    const invalidFields = requiredFields.filter((field) => {
        const value = metadata.data[field];
        return typeof value !== "string" || value.trim().length === 0;
    });
    if (invalidFields.length > 0) {
        return fail(`Invalid frontmatter: required fields must be present as nonempty strings: ${invalidFields.join(", ")}.`);
    }
    return { metadata: metadata.data };
}
const evaluateTool = defineTool("evaluate", {
    description: "Evaluates the quality of a given code snippet and provides a score and reasoning.",
    parameters: EvalSchema,
    defer: "never",
    skipPermission: true,
    isTerminal: true,
    handler: async (value) => {
        return { score: value.score, reasoning: value.reasoning };
    },
});
const baseRole = `
You are an evaluator for agents, prompts, skills and tools. You will be given a code snippet and you need to evaluate its quality based on the following criteria:
1. Correctness: Does the code do what it is supposed to do?
2. Efficiency: Is the code optimized for performance?
3. Readability: Is the code easy to read and understand?
4. Maintainability: Is the code structured in a way that makes it easy to maintain and extend?
`;
const scoringSystem = `
<scoring>
The scoring system is based on a scale of 1 to 10, where 1 is the lowest and 10 is the highest. 
Every evaluation should include a reasoning to justify the score given.
1 - Failing: The agent or skill does not meet the basic requirements and fails to perform its intended function.
2 - Poor: The agent or skill has significant issues that hinder its performance and usability.
3 - Below Average: The agent or skill performs below expectations and has noticeable flaws
4 - Average: The agent or skill meets basic expectations but lacks advanced features or optimizations.
5 - Above Average: The agent or skill performs well in most scenarios but has some areas for improvement.
6 - Good: The agent or skill performs well and meets expectations, with minor areas for improvement.
7 - Very Good: The agent or skill performs very well, with only minor issues or areas for improvement.
8 - Excellent: The agent or skill performs excellently, with only minor issues
9 - Outstanding: The agent or skill performs exceptionally well, with very few issues or areas for improvement.
10 - Exceptional: The agent or skill performs exceptionally well, exceeding expectations and demonstrating advanced capabilities
</scoring>`;
const agentDefinitionCriteria = `
<agent-definition-criteria>
In addition to the general criteria, assess the agent's configuration against its actual task and instructions:
1. Model suitability: Is the selected model capable enough for the task's complexity and reasoning demands, without being unnecessarily large or costly for a simple task? Flag both underpowered and overpowered choices. An omitted model inherits the caller's default; do not invent that model, current model availability, or pricing, and do not penalize omission alone.
2. Tool coverage and least privilege: Are the allowed tools sufficient to perform the task, without granting unnecessarily broad permissions? Flag both missing capabilities and excessive access. Omitted tools or a wildcard allow all available tools; an empty list allows none. Shell/execute tools can modify files even without an edit tool. Consider client-specific aliases, tool sets, and MCP tools rather than treating unfamiliar names as invalid.
3. Explain concrete model or tool mismatches in the reasoning and reflect them in the quality score. Judge the configuration in context, not against a fixed model ranking or tool count.
</agent-definition-criteria>
`;
const skillDefinitionCriteria = `
<skill-definition-criteria>
In addition to the general criteria, assess the skill's discovery metadata:
1. Name suitability: Does the name accurately and specifically identify the skill's actual purpose and capabilities?
2. Description suitability: Does the description explain what the skill does and when to use it? Compare its trigger boundaries and claims against the instructions and supporting artifacts; flag vague, misleading, overly broad, or overly narrow descriptions.
3. Folder consistency: Use the programmatic skill-folder-check below. If checked and nameMatchesFolder is false, reduce the quality score and explain the mismatch, including the expected folder name. A mismatch is a quality issue, not an automatic score of 1; do not apply a fixed numeric penalty. If checked is false, folder matching is unavailable; do not infer a folder name or claim it was verified.
</skill-definition-criteria>
`;
async function evaluateBase(systemMessage, evaluationPrompt) {
    for (let attempt = 1; attempt <= maxEvaluationAttempts; attempt++) {
        try {
            return await evaluateBaseAttempt(systemMessage, evaluationPrompt);
        }
        catch (error) {
            if (!isEvalFailure(error)) {
                throw error;
            }
            if (attempt === maxEvaluationAttempts) {
                throw new Error("Maximum retry attempts reached during evaluation.", { cause: "eval_failure" });
            }
            console.error(`Evaluation failed, retrying (${attempt}/${maxEvaluationAttempts})...`, error);
        }
    }
    throw new Error("Maximum retry attempts reached during evaluation.", { cause: "eval_failure" });
}
async function evaluateBaseAttempt(systemMessage, evaluationPrompt) {
    const client = new CopilotClient();
    await client.start();
    try {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: systemMessage,
            },
            enableSessionStore: false,
            tools: [evaluateTool],
        });
        const result = await session.sendAndWait(evaluationPrompt);
        if (!result?.data.toolRequests || result.data.toolRequests.length === 0) {
            throw new Error("No tool requests found in the evaluation result.", { cause: "eval_failure" });
        }
        const evaluations = result.data.toolRequests
            .filter((request) => request.name === "evaluate")
            .map((request) => {
            const args = request.arguments;
            const isRecord = typeof args === "object" && args !== null && !Array.isArray(args);
            return {
                score: isRecord ? args.score : undefined,
                reasoning: isRecord ? args.reasoning : undefined,
            };
        });
        if (evaluations.length === 0) {
            throw new Error("No evaluations found in the tool requests.", { cause: "eval_failure" });
        }
        const evaluation = evaluations[0];
        if (evaluation?.score === undefined || evaluation?.reasoning === undefined) {
            throw new Error("Incomplete evaluation result.", { cause: "eval_failure" });
        }
        return evaluation;
    }
    catch (error) {
        console.error("Error during evaluation:", error);
        throw error;
    }
    finally {
        await client.stop();
    }
}
async function evaluatePerformance(userPrompt, processOutput, expectations) {
    const systemMessage = `
${baseRole}
${scoringSystem}
`;
    const evaluationPrompt = `
Evaluate the performance based on the following user prompt, process output, and expectations.

<user-prompt>
${userPrompt}
</user-prompt>

<process-output>
${processOutput}
</process-output>

<expectations>
${expectations}
</expectations>
`;
    return await evaluateBase(systemMessage, evaluationPrompt);
}
async function evaluateSkillDefinition(skillDefinition, skillArtifacts, skillDirectory) {
    const frontmatter = validateFrontmatter(skillDefinition, ["name", "description"]);
    if ("failure" in frontmatter) {
        return frontmatter.failure;
    }
    const folderName = skillDirectory === undefined ? undefined : path.basename(path.resolve(skillDirectory));
    const folderCheck = folderName === undefined
        ? { checked: false }
        : { checked: true, folderName, name: frontmatter.metadata.name, nameMatchesFolder: frontmatter.metadata.name === folderName };
    const systemMessage = `
${baseRole}
${scoringSystem}
${skillDefinitionCriteria}
`;
    let evaluationPrompt = `
Evaluate the following skill definition based on the criteria provided.

<skill-folder-check>
${JSON.stringify(folderCheck)}
</skill-folder-check>

<skill-definition>
${skillDefinition}
</skill-definition>
`;
    if (skillArtifacts && skillArtifacts.length > 0) {
        evaluationPrompt += `
<skill-artifacts>
${skillArtifacts.map(artifact => `<artifact path="${artifact.path}">${artifact.content}</artifact>`).join("\n")}
</skill-artifacts>
`;
    }
    return await evaluateBase(systemMessage, evaluationPrompt);
}
async function evaluateAgentDefinition(agentDefinition) {
    const frontmatter = validateFrontmatter(agentDefinition, ["description"]);
    if ("failure" in frontmatter) {
        return frontmatter.failure;
    }
    const systemMessage = `
${baseRole}
${scoringSystem}
${agentDefinitionCriteria}
`;
    const evaluationPrompt = `
Evaluate the following agent definition based on the criteria provided. 

<agent-definition>
${agentDefinition}
</agent-definition>
`;
    return await evaluateBase(systemMessage, evaluationPrompt);
}
export { evaluatePerformance, evaluateSkillDefinition, evaluateAgentDefinition };
//# sourceMappingURL=evaluate.js.map