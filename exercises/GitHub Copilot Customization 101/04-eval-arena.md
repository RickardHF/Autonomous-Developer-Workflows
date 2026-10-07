# Exercise 4 — Eval Arena 📊

> **Goal:** learn a lightweight manual evaluation technique by comparing working agents/skills
> against the ones you fixed in the Bug Hunt.

This exercise is about observing behavior as a user. Agentic Workflows & Evaluation builds on this by changing the
programmatic evaluator and automating evaluation in CI/CD.

## Step 1 — Set up a fair comparison

- [ ] Choose one fixed prompt per customization and write down what a successful response must
  do before running it.
- [ ] Use the same model, chat mode, prompt, and attached context for each pair below:
  - Your Exercise 1 skills (`hello-ascii`, `greeting`, `gh-issue-creator`) — the "good" set.
  - The Bug Hunt files, using the **before** results saved in
    `notes/bug-hunt-baseline.md` and new **after** results — a direct good-vs-bad comparison.
- [ ] For agents, compare `code-reviewer`/`doc-writer` with the pre-fix `broken-reviewer` result.
- [ ] Rerun the exact Bug Hunt prompts from Exercise 3 and record whether each customization was
  referenced, what tools were used, and whether the original failure is resolved.
- [ ] For `broken-script-conventions`, compare the saved before result with the repaired result for
  "Create a repository script that checks Markdown links." Check specifically for Bash, the
  `check-markdown-links.sh` filename, and the `scripts/check-markdown-links.sh` path.

## Step 2 — Compare what happened

Look specifically at:

- **Tools** — was the broken version allowed to do something it shouldn't (or blocked from
  something it needed)?
- **Description** — was it vague, or did it clearly state the persona/purpose?
- **Trigger breadth** — for skills, did the "When to use" section cover realistic phrasing?
- **Context usage** — did the broken version waste context re-reading things or producing
  irrelevant tool calls?
- **Token cost** — did fixing the issue also make responses shorter/cheaper, or did it need more
  context to work correctly?

Do not reduce the comparison to a single score. The purpose is to connect configuration choices
to observable behavior and explain the evidence behind your judgment.

## Step 3 — Write it up

- [ ] Create `notes/eval-arena.md` (100+ characters) summarizing what you found — mention at
      least two of: tools, description, trigger, context, token, and what you specifically
      changed to fix each issue.
- [ ] End with one limitation of your comparison, such as a single run, subjective expectations,
  or model variability.

---

**Next up:** [Exercise 5 — Pitfalls & Tips Quiz](05-pitfalls-quiz.md)
