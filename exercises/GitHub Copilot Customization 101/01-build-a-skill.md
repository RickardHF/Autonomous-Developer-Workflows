# Exercise 1 — Build a Skill 🧩

> **Goal:** learn how Copilot skills work by building three of your own, then test one against
> realistic trigger phrases.

## What's a skill?

A skill is a folder of instructions Copilot can load automatically when it decides it's
relevant to your request. Each skill lives in `.github/skills/<skill-name>/SKILL.md` and starts
with YAML frontmatter containing `name` and `description`. The `name` must match the folder name.
Copilot uses the `description` to decide when to load the skill, while a **"When to use"** section
in the body can reinforce those trigger boundaries for anyone maintaining it. Keep both narrow
for explicit, controlled invocation or broaden them for automatic, implicit invocation.

> 📚 Want the full picture first — file anatomy, progressive disclosure, trigger tuning? See the
> [Skills reference](../../docs/skills.md) and the
> [Customization overview](../../docs/copilot-customization.md).

## Step 1 — An explicit skill: `hello-ascii`

- [ ] Create `.github/skills/hello-ascii/SKILL.md` with:
  - YAML frontmatter with `name: hello-ascii` and a narrow `description` containing the trigger.
  - A title.
  - A `## When to use` section naming one explicit trigger phrase, e.g. *"show hello in ASCII
    art"*.
  - A `## Instructions` section telling Copilot to reply with ASCII art.
- [ ] Test it: open Copilot Chat (Agent mode) and type exactly that phrase. Confirm it responds
      with your ASCII art.

## Step 2 — An implicit skill: `greeting`

- [ ] Create `.github/skills/greeting/SKILL.md` with `name: greeting` and a broad `description`
      in its YAML frontmatter. Include at least **4** varied greeting phrases (e.g. "hello",
      "hi", "good morning", a greeting in another language) in both the description and a
      `## When to use` section, plus a `## Instructions` section for a friendly response.
- [ ] Test it: open a **new** chat session and just say "Hi" — no explicit mention of the skill.
      Confirm Copilot picks it up automatically.
- [ ] Compare: temporarily narrow the `greeting` skill's frontmatter `description` and try the
      same greeting — notice how the *breadth of the description*, not the instructions, is what
      makes a skill fire implicitly. Restore the broad description afterward.

> **Heads-up:** the repo ships with an intentionally weak `broken-script-conventions` skill used
> in Exercise 3. It demonstrates the same skill-anatomy problems through a separate repository
> scripting workflow, so your `greeting` skill can stay enabled.

## Step 3 — A real one: `gh-issue-creator`

This is where skills earn their keep — encoding a real team workflow.

- [ ] Create `.github/skills/gh-issue-creator/SKILL.md` with matching `name` and `description`
      fields in YAML frontmatter. Teach it to create issues with `gh issue create`.
- [ ] Start with one working bug-report template at
      `.github/skills/gh-issue-creator/templates/bug.md`. Keep it compact, for example:

  ```markdown
  ## Summary
  <!-- What went wrong? -->

  ## Steps to reproduce
  1.

  ## Expected behavior

  ## Actual behavior
  ```

- [ ] Reference `templates/bug.md` from `SKILL.md`, then test the workflow end to end: ask
      Copilot to file a bug report and confirm it uses the template and appropriate labels.
- [ ] Add a feature-request template at
      `.github/skills/gh-issue-creator/templates/feature.md`, for example:

  ```markdown
  ## Problem
  <!-- What user need or limitation should this address? -->

  ## Proposed outcome

  ## Acceptance criteria
  -
  ```

- [ ] Update `SKILL.md` to reference **both** template paths and route bug reports to `bug.md`
      and enhancement requests to `feature.md`. Explain how Copilot should determine the issue
      type from the request, load the selected template before drafting the issue body, and ask for
      clarification when the type is genuinely ambiguous.
- [ ] Refine `## When to use` with:
  - Positive triggers such as "file a bug", "open an issue", and "request a feature".
  - Out-of-scope requests such as reviewing code, editing an existing issue, or opening a pull
    request.
  - The bug-versus-feature routing rule.
- [ ] Test realistic boundaries. Prompts such as "File a bug for the broken pause control" and
      "Open a feature request for controller support" should invoke the skill and select different
      templates. Prompts such as "Review the pause-control code" and "Draft a pull request" should
      not invoke it.

Agentic Workflows & Evaluation turns observations like these into programmatic and agentic evaluation checks. Here,
the goal is simply to learn how description wording affects skill discovery.

---

**Next up:** [Exercise 2 — Build an Agent](02-build-an-agent.md)
