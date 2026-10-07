# Agent Skills — Reference

Skills are the most portable Copilot customization: folders of instructions (and optionally
scripts, templates, and examples) that Copilot loads when your prompt matches a skill's described
capability. In supported clients, you can also invoke a skill directly as `/skill-name`. Unlike
project-wide instructions, skills are **task-level**; unlike custom agents, they package reusable
procedures and resources rather than a role and tool allowlist.

This is the concept behind [Exercise 1 — Build a Skill](../exercises/GitHub%20Copilot%20Customization%20101/01-build-a-skill.md).

## File structure

Each project skill is a directory under `.github/skills/`, `.agents/skills/`, or
`.claude/skills/` containing a `SKILL.md`, plus any resources the instructions reference. This
workshop uses `.github/skills/`:

```
.github/skills/
├── gh-issue-creator/
│   ├── SKILL.md              # Main skill definition
│   ├── bug-template.md       # Resource: issue template
│   └── feature-template.md   # Resource: issue template
└── greeting/
    └── SKILL.md
```

## SKILL.md anatomy

```markdown
---
name: gh-issue-creator
description: >
  Create GitHub issues via gh issue create, using bug or
  feature templates. Use when asked to file, open, or
  create an issue or bug report.
---

# GitHub Issue Creator

## When to use this skill
- User asks to file a bug report
- User asks to open a feature request

## Instructions
1. Pick the matching template: [bug-template.md](./bug-template.md)
2. Fill in the fields from the user's description
3. Run `gh issue create` with the right labels
```

Rules that trip people up:

- The frontmatter `name` **must match the folder name**.
- The `name` must contain only lowercase letters, numbers, and hyphens and can be at most 64
  characters.
- The `name` and `description` are what Copilot sees before deciding to load the skill — the body
  is not loaded at matching time. Put the capability and realistic use cases in the description.
- The `description` can be at most 1024 characters.
- Relative links to resource files must resolve from the skill directory.

Skills can also use optional frontmatter to control invocation. `user-invocable: false` hides a
skill from the slash-command menu while preserving automatic matching;
`disable-model-invocation: true` disables automatic matching and makes the skill manual-only.
Copilot CLI also supports `allowed-tools` to pre-approve named tools for a trusted skill; this is
not a general tool allowlist, and pre-approving shell execution requires careful review.

## Progressive disclosure — why skills are cheap

Skills use a three-level loading model to keep the context window lean:

1. **Level 1 (discovery):** the frontmatter `name` + `description` is available for matching.
2. **Level 2 (on match):** when Copilot decides a skill is relevant, the full `SKILL.md` body
   is loaded.
3. **Level 3 (on reference):** resource files (templates, examples, scripts) are loaded only if
   the instructions link to them and they're needed.

This means you can install many skills without bloating every request. A bad description prevents
reliable automatic discovery, although direct slash-command invocation can still load the skill.

## Tuning triggers: explicit vs. implicit

The breadth of the `description` (not the instructions) controls when a skill fires:

| Style | Description wording | Behavior |
|---|---|---|
| **Explicit** | Narrow, names one exact trigger phrase | Matches a narrow set of requests; direct `/skill-name` invocation remains available by default |
| **Implicit** | Broad, keyword-rich, lists varied phrasings | Loads automatically for more related intents, but can over-trigger |

You build one of each in Exercise 1, and diagnose a description that's *too* narrow in
[Exercise 3 — Bug Hunt](../exercises/GitHub%20Copilot%20Customization%20101/03-bug-hunt.md).

## Skills vs. instructions

| | Instructions | Skills |
|---|---|---|
| Activation | Project-wide automatically, or targeted by pattern/task | Auto-loaded when relevant or invoked directly |
| Scope | Project-wide or targeted guidance | Task-specific capabilities |
| Resources | Markdown text only | Can include scripts, templates, examples |
| Portability | Depends on the instruction format and harness | Open standard across compatible agents |
| Best for | Coding standards, architecture context | Specialized workflows, tools, procedures |

Skills are an **open standard**: a skill you write for Copilot in VS Code also works with
Copilot CLI and Copilot cloud agent. Project skills can live in `.github/skills/`,
`.agents/skills/`, or `.claude/skills/`. Personal skill locations vary by client; Copilot uses
`~/.copilot/skills/`, and compatible clients can also discover `~/.agents/skills/` or
`~/.claude/skills/`.

## Best practices

- Write clear, **keyword-rich descriptions** — matching happens from the name and description
  before the body is loaded.
- Include a `## When to use` section so maintainers (and evaluators) can see the intended
  trigger boundaries at a glance.
- Use progressive disclosure deliberately: core instructions in `SKILL.md`, details in
  reference files.
- Include example inputs/outputs to demonstrate expected behavior.
- **Test triggering**: prompt with phrases that *should* fire the skill and phrases that
  *shouldn't*, and verify both. The workshop records this behavior manually; the evaluator scores
  definition quality rather than executing trigger scenarios.
- Review community skills before adopting them — they're instructions your agent will follow.

## See also

- [Customization overview](copilot-customization.md)
- [Custom Agents reference](custom-agents.md)
- [VS Code docs: Agent skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)
