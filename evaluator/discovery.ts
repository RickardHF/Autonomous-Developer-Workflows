import { glob } from "glob";
import path from "node:path";

export async function discoverDefinitions(directory: string) {
    const agentFiles = await glob([
        path.posix.join(directory, ".github/agents/*.agent.md"),
        path.posix.join(directory, ".agents/agents/*.agent.md"),
    ]);
    const skillDirectories = await glob([
        path.posix.join(directory, ".agents/skills/*/"),
        path.posix.join(directory, ".github/skills/*/"),
    ], { mark: true });
    return { agentFiles, skillDirectories };
}
