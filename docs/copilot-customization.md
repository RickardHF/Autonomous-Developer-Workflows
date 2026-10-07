# Copilot Customization Overview

A quick reference for the customization mechanisms you'll use in the GitHub Copilot Customization 101 exercises.
Each mechanism solves a different problem — knowing *which one to reach for* is most of the
skill.

## The landscape at a glance

| Mechanism | What it's for | How it activates | Where it lives |
|---|---|---|---|
| **Instructions** | Project context, standards, and targeted guidance | Project-wide automatically; targeted files by pattern or task relevance | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, or a harness-compatible file such as `AGENTS.md` |
| **Prompt files** | Reusable task templates for the VS Code Local agent | On-demand via `/command` | `.github/prompts/*.prompt.md` |
| **Custom agents** | Named roles with specific tools and rules | Selected directly, delegated to as a subagent, or inferred where supported | `.github/agents/*.agent.md` |
| **Agent skills** | Portable specialized capabilities with resources | Auto-loaded by relevance or invoked as `/skill-name` | `.github/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`, or `.claude/skills/*/SKILL.md` |
| **MCP servers** | Connections to external systems and APIs | The agent invokes the server's tools when needed | `.mcp.json`, `.github/mcp.json`, or `.vscode/mcp.json`, depending on the client |
| **Hooks** | Deterministic checks or actions at agent lifecycle events | Run by the client when the configured event occurs | Client-specific hook configuration, such as `.github/hooks/` |

> **Current platform note:** prompt files continue to work with the VS Code Local agent, but are
> deprecated and not loaded in Agent Host sessions. Prefer an agent skill for a new portable,
> on-demand workflow.

Most repository-level customizations can be committed and shared with the team. Their formats are
not identical: MCP configuration is JSON, project-wide instruction files are plain Markdown, and
targeted instructions, agents, prompts, and skills can use YAML frontmatter.

## Picking the right mechanism

| You want to… | Reach for | Why |
|---|---|---|
| Set project-wide standards for every interaction | Instructions | Always-on, zero friction |
| Apply rules only to certain file types | File-targeted instructions (`applyTo` globs) | Precise scoping |
| Run a repeatable workflow on demand | Agent skills | Invocable, auto-discoverable, portable, and able to bundle resources |
| Define a role with a restricted toolset | Custom agents | Reusable role configuration for direct use or delegation |
| Chain phases together (plan → implement → review) | Custom agents with handoffs | Structured pipelines |
| Package a capability with templates or scripts | Agent skills | Self-contained, auto-activated, portable |
| Talk to external systems (DBs, issue trackers, browsers) | MCP servers | Exposes external tools to the agent |
| Guarantee a command runs at a lifecycle event | Hooks | Runs outside the model's decision-making |

These layer together: instructions set the baseline, agents define roles, skills load per task,
MCP extends reach beyond the repo, and hooks enforce deterministic actions.

## How the mechanisms combine

The exact discovery and merge behavior depends on the selected agent harness, so do not rely on a
fixed universal loading order. Conceptually, the pieces have separate responsibilities:

1. **Instructions** provide applicable repository, user, and organization guidance.
2. **The active agent** supplies role-specific instructions and an available-tool configuration.
3. **Skills** are discovered from their names and descriptions; a relevant or explicitly invoked
   skill adds its instructions and can make referenced resources available.
4. **MCP servers** add tools and other external capabilities.
5. **Your prompt and attached context** define the immediate task.
6. **Hooks**, where supported, run configured commands at lifecycle events independently of the
   model's choices.

For the VS Code Local agent, a prompt file can specify its own agent, model, and tools. Its tool
list takes priority over the referenced or currently selected agent's tools.

> **Tip:** in VS Code, select **Show Agent Debug Logs** from the Chat view's `...` menu, or run
> **Developer: Open Agent Debug Logs** from the Command Palette. This is the first place to check
> when a skill or agent does not behave as expected (you'll use that evidence in
> [Exercise 3 — Bug Hunt](../exercises/GitHub%20Copilot%20Customization%20101/03-bug-hunt.md)).

## Comparison matrix

| | Instructions | Prompt files | Custom agents | Agent skills |
|---|---|---|---|---|
| Activation | Automatic project-wide, by file pattern, or by task relevance | On-demand (`/` command) in the VS Code Local agent | Selected, inferred, or delegated, depending on the harness | Auto-matched by description or explicitly invoked |
| Scope | Project-wide or targeted | Per-invocation | Role or delegated subtask | Task-level |
| Can bundle scripts/files | No | No | No | Yes (full directory) |
| Specifies tools | No | Yes | Yes | No |
| Specifies model | No | Yes | Yes | No |
| Portability | Format-dependent | VS Code Local agent only | Supported across Copilot surfaces, with harness-specific fields | Yes (open standard) |

## Deep dives

- [Agent Skills reference](skills.md) — anatomy, progressive disclosure, trigger tuning.
- [Custom Agents reference](custom-agents.md) — frontmatter, tool restrictions, handoffs.
- [Agent orchestration in this repo](agent-orchestration.md) — the CI pipeline that turns
  labeled issues into reviewed PRs.

## Further reading

- [VS Code agent customization concepts](https://code.visualstudio.com/docs/agents/concepts/customization)
- [GitHub Copilot docs](https://docs.github.com/en/copilot)
- [Copilot Academy](https://copilot-academy.github.io/) — self-paced workshops and labs,
  including the full Customization Handbook this overview is modeled on
- [github/awesome-copilot](https://github.com/github/awesome-copilot) — community-contributed
  instructions, prompts, agents, and skills
