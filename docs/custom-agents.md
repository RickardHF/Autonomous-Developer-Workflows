# Custom Agents — Reference

Custom agents define a reusable role with its own instructions, tool configuration, and optionally
a preferred model. You can select a custom agent directly. Depending on the Copilot surface, the
main agent can also infer that an agent fits a request or delegate a bounded task to it as a
subagent with a separate context window.

One line to keep the distinction straight: a **skill is knowledge Copilot picks up
or you invoke for a task; an agent is a role with instructions and capabilities.**

This is the concept behind [Exercise 2 — Build an Agent](../exercises/GitHub%20Copilot%20Customization%20101/02-build-an-agent.md).

## File structure

Repository agents are single Markdown files in `.github/agents/<name>.agent.md`. Compatible
Claude-format agents can instead live under `.claude/agents/`, while personal Copilot agents live
under `~/.copilot/agents/`.

```markdown
---
name: code-reviewer
description: Reviews code for bugs, style, and risky patterns; reports findings without editing.
tools: ["search", "read"]
---

# Code Review Instructions

You are a careful code reviewer. Examine the requested files and report:
- Correctness issues and potential bugs
- Risky patterns (unvalidated input, swallowed errors)
- Style inconsistencies

Never modify any file. Present findings as a prioritized list.
```

The Markdown body supplies the instructions the agent follows whenever it runs.

## Key frontmatter fields

| Field | Purpose | Notes |
|---|---|---|
| `name` | Display name | Optional; defaults to the filename |
| `description` | What the agent does and when to use it | Helps users and other agents pick the right role |
| `tools` | Tools or tool sets available to the agent | Omit the field to allow all tools; use current tool names from the target client |
| `model` | Preferred model(s), with fallback order | A model name or prioritized array of model names |
| `agents` | Agents available for delegation | Include the `agent` tool when configuring this field |
| `user-invocable` | Whether the agent appears in the picker | Defaults to `true` |
| `disable-model-invocation` | Whether other agents may invoke it as a subagent | Defaults to `false` |
| `handoffs` | Suggested buttons that transition to another agent | Supported by VS Code; see below |
| `include-custom-instructions` | Apply repository instructions when Copilot CLI runs the agent as a subagent | Directly selected agents already receive repository instructions |

## Tool restrictions — the main safety lever

The `tools` list is an *allowlist*: anything not on it is unavailable to that agent. If the field
is omitted, all available tools are enabled by default. This is deterministic in a way prose
instructions are not — a directly running agent without any editing-capable tool cannot edit, no
matter how it is prompted.

Tool names and tool sets vary by client and installed extensions. Use the target client's tool
picker or hover information rather than copying an allowlist from a different surface. The
workshop uses simplified `read`, `search`, and `edit` names to focus on the allowlist concept.

In [Exercise 3 — Bug Hunt](../exercises/GitHub%20Copilot%20Customization%20101/03-bug-hunt.md) you'll meet a "read-only"
reviewer whose tools list quietly includes `edit` — the fix is one line, and the lesson is to
treat the tools list as the contract, not the prose.

## Handoffs — chaining agents

In VS Code, handoffs let you build guided multi-step workflows (plan → implement → review). When
one agent finishes, the user sees a button that transitions to the next agent with a pre-filled
prompt:

```yaml
handoffs:
  - label: Implement Plan
    agent: agent
    prompt: Implement the plan outlined above.
    send: false
```

With `send: true` the prompt auto-submits; with `send: false` the user can review and edit it
first. This repo's CI pipeline applies the same idea non-interactively — see
[Agent orchestration](agent-orchestration.md) for `spec_analyzer` → `risk_reviewer` →
`implementer` chained through GitHub Actions.

## When to use a custom agent

- You need a **named persona** that consistently orchestrates tools for a workflow.
- You want to **restrict tools** to prevent unintended actions.
- You need **multi-step workflows** through subagent delegation or VS Code handoff transitions.
- You want certain operations to always use a specific, high-capability **model**.

Agents combine with instructions (standards) and skills (specialized tasks). Exact discovery and
instruction inheritance depend on the selected harness. In particular, Copilot CLI subagents do
not inherit repository custom instructions unless the agent sets
`include-custom-instructions: true`.

## Agents vs. skills vs. prompt files

| | Custom agent | Skill | Prompt file |
|---|---|---|---|
| Activated by | User selection, inference, or delegation, depending on the surface | Description matching or `/skill-name` | `/command` in the VS Code Local agent |
| Scope | Role or delegated subtask | Single task | Single invocation |
| Controls tools | Yes | No | Yes (overrides the agent's for that request) |
| Controls model | Yes | No | Yes |
| Bundles resources | No | Yes | No |

> Prompt files are deprecated for Agent Host sessions and are not loaded there. Prefer a skill for
> a new portable workflow.

## Best practices

- Make the `description` specific (what it does *and* what it refuses to do) — vague
  descriptions produce vague behavior and make direct or inferred selection less reliable.
- Keep the `tools` list minimal; remember that omitting it enables all available tools.
- Put process in the body: how to start, what to output, what *not* to do.
- Test the negative case: ask a read-only agent to edit something and confirm it cannot.
- Let Copilot draft the body — write a one-paragraph persona summary and ask it to expand
  (Exercise 2, Step 2).

## See also

- [Customization overview](copilot-customization.md)
- [Agent Skills reference](skills.md)
- [Agent orchestration in this repo](agent-orchestration.md)
- [VS Code docs: Custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents)
