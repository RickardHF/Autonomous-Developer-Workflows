# Exercise 2 — Build an Agent 🤖

> **Goal:** understand agents as personas (as opposed to skills, which are knowledge), and build
> three of your own.

## Skills vs. agents, in one line

A **skill** is knowledge Copilot picks up automatically. An **agent** is a persona *you*
manually select, with its own tone, focus, and restricted toolset. Agents live as single
Markdown files with YAML frontmatter in `.github/agents/<name>.agent.md`.

> 📚 For frontmatter fields, tool restrictions, and handoffs in depth, see the
> [Agents reference](../../docs/custom-agents.md).

## Step 1 — A doc writer with edit access

1. [ ] Create `.github/agents/doc-writer.agent.md` — its `tools` list must include
       `"edit"`, and the description/body should focus on documentation, not code logic.
2. [ ] Choose a concrete source target and audience before prompting the agent. For example,
       document a function for API consumers, a module for maintainers, or a configuration workflow
       for repository contributors.
3. [ ] Choose the visible documentation artifact you expect it to change: a named standalone guide
       such as `docs/<topic>.md`, a named section in `README.md`, or API/function documentation in
       an existing documentation file.
4. [ ] Select the agent and ask it to inspect both the source and existing documentation before it
       edits the named artifact. Require the result to cover the target's purpose, usage,
       inputs/outputs or configuration, and relevant edge cases. State that it must not change code
       behavior.
5. [ ] Inspect the diff and confirm the agent made a substantive change to the named documentation
       file rather than only describing what it would write.
6. [ ] Check the result against the source for factual accuracy. Confirm that the selected agent
       had `edit` access and that the diff contains documentation changes only.

## Step 2 — BONUS: design your own

- [ ] Create any additional `.github/agents/<your-agent>.agent.md` with valid `name`, `description`
      (15+ characters), and a non-empty `tools` list. Ideas: a security reviewer, a migration
      assistant, a test generator, a release-notes writer.
- [ ] Ask Copilot to expand a one-paragraph summary into full agent instructions for you — you
      don't have to write the polished prompt yourself.
- [ ] Test it from the agent dropdown.

---

**Next up:** [Exercise 3 — Bug Hunt](03-bug-hunt.md)
