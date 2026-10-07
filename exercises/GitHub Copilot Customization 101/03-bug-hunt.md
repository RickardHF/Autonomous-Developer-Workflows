# Exercise 3 — Bug Hunt 🐛

> **Goal:** get hands-on practice diagnosing and fixing broken agents/skills — the pitfalls you
> just avoided in Exercises 1–2 are baked into these on purpose.

Two intentionally broken files are waiting for you:

- `.github/agents/broken-reviewer.agent.md`
- `.github/skills/broken-script-conventions/SKILL.md`

> **See the current state first.** The [Evaluation Status badge in the README](../../README.md#evaluation-status)
> reflects the latest scores for every agent and skill in this repo. Before starting, confirm it
> lists both broken files above; if it does not, ask the instructor to refresh it. Note their
> current scores as the evaluation baseline. The badge is refreshed by the
> [Evaluate Agents & Skills](../../.github/workflows/evaluate.yml) workflow, which you'll run
> yourself at the end of this exercise.

## Step 1 — See it fail

- [ ] Set the expected reviewer behavior before testing: a read-only review focused on correctness
      and maintainability, with no file edits.
- [ ] Select the broken reviewer agent from the agent dropdown (or ask Copilot to load
      `.github/agents/broken-reviewer.agent.md`) and give it a review task. Compare what happens
      with the expectation above.
- [ ] Set the expected skill behavior before testing:
  - Language: Bash.
  - Filename: `check-markdown-links.sh` in kebab case with a `.sh` extension.
  - Path: `scripts/check-markdown-links.sh`.
- [ ] In a separate new chat using default Agent mode, run this exact prompt: "Create a repository
      script that checks Markdown links." Inspect the response references and resulting diff. Do
      not correct the language, filename, or path yourself.

## Step 2 — Capture the baseline

Before changing either file, save evidence that you can compare after the fix.

- [ ] Create `notes/bug-hunt-baseline.md` and record the model you are using.
- [ ] With the broken reviewer selected, run this exact prompt and paste the response into your
      note: "Review `.github/hooks/scripts/block-dangerous-commands.sh` for correctness and
      maintainability. Do not modify files."
- [ ] In a separate new chat using default Agent mode and the same model, run the exact prompt
      "Create a repository script that checks Markdown links."
- [ ] Record the script result in your note:
  - Whether `broken-script-conventions` appeared in the response references.
  - The language, filename, and path that were actually produced.
  - The resulting diff, tools used, and any mismatch with the expected result.
- [ ] Remove only the script files created by the baseline run. Keep the evidence in your note so
      the repaired skill can be retested from the same clean starting point.

Keep these prompts unchanged when you retest. That makes the before-and-after comparison about
your customization changes rather than a different prompt, model, or pre-existing script.

## Step 3 — Troubleshoot

- [ ] In the reviewer chat, switch from the broken reviewer to default Agent mode. Keep the
      existing chat open so its earlier behavior remains available for investigation. The script
      chat is already in default Agent mode.
- [ ] In each chat, run: `/troubleshoot explain why the customization did not behave as I expected;
      base the answer on evidence from this chat's debug log`.
- [ ] Check whether the evidence confirms that the expected agent or skill loaded, which tools were
      available, and whether the problem came from configuration or model behavior. Add those
      findings to `notes/bug-hunt-baseline.md`.
- [ ] Compare the evidence with the files themselves. Look closely at:
  - The agent's `tools` list — does it allow more than it should?
  - The agent's `description` — is it specific enough to be selected/understood confidently?
  - The skill's frontmatter `description` — is it too narrow to cover realistic repository-script
    requests?
  - The skill's `## When to use` section — does it identify enough relevant triggers and
    boundaries?
  - The skill's `## Instructions` — does it define observable language and filename conventions?

## Step 4 — Fix and retest

- [ ] Edit `.github/agents/broken-reviewer.agent.md` directly: fix the description so it clearly
      describes code review, and remove `edit`/`write` from its `tools` list so it's genuinely
      read-only.
- [ ] Edit `.github/skills/broken-script-conventions/SKILL.md` directly:
  - Broaden its frontmatter `description` to cover small repository automation scripts and
    realistic requests to create checks, validation, or maintenance scripts.
  - Expand `## When to use` with varied positive triggers for small repository automation scripts
    and out-of-scope cases such as application features or large command-line tools.
  - Flesh out `## Instructions` so small repository automation scripts prefer Bash and use a
    descriptive kebab-case filename with a `.sh` extension, stored under the repository-root
    `scripts/` directory.
- [ ] Open fresh chats with the same model and rerun both exact baseline prompts. Do not add extra
      filename or language hints to the script prompt.
- [ ] Confirm the reviewer is read-only and focused. For the script, confirm
      `broken-script-conventions` appears in the response references and the result is Bash at
      `scripts/check-markdown-links.sh`.
- [ ] Add the after responses and diffs to `notes/bug-hunt-baseline.md`. Compare before and after
      using the same evidence fields: language, filename, path, references, and tools used.

## Step 5 — Evaluate locally, publish, and update the state

Your manual tests show the behavioral difference. Before publishing, use one of these supported
local evaluation routes for a second opinion grounded in the same rubric as the badge:

- [ ] Run one local evaluation option and review the scores and reasoning for both repaired files:
  - **Evaluator agent:** select `.github/agents/evaluator.agent.md` and ask it to evaluate
    `.github/agents/broken-reviewer.agent.md` and
    `.github/skills/broken-script-conventions`.
  - **Direct CLI:** from the repository root, run:

    ```bash
    cd evaluator
    npx tsx cli.ts evaluate --files ../.github/agents/broken-reviewer.agent.md,../.github/skills/broken-script-conventions --json
    ```

    See the [evaluator documentation](../../docs/evaluator.md) for setup, supported paths, and
    output details.

- [ ] Compare the local evaluation with your manual evidence and confirm both repaired definitions
      improved before publishing them.
- [ ] Commit your edits to the two files on the `main` branch and push to the repository:

  ```bash
  git add .github/agents/broken-reviewer.agent.md .github/skills/broken-script-conventions/SKILL.md
  git commit -m "fix: repair broken reviewer agent and script conventions skill"
  git push origin main
  ```

- [ ] Trigger the **Evaluate Agents & Skills** workflow to re-score everything and refresh the badge.
      Either use the CLI:

  ```bash
  gh workflow run evaluate.yml --ref main
  ```

  or open the **Actions** tab on GitHub, select **Evaluate Agents & Skills**, and click **Run workflow**.
- [ ] Watch the run finish (`gh run watch` or the Actions tab). When it completes, the workflow
      commits an updated `eval-badge.svg`.
- [ ] Refresh the [Evaluation Status badge in the README](../../README.md#evaluation-status) and
      confirm the scores for the reviewer and script-conventions skill improved compared to the
      baseline you noted in Step 1.

---

**Next up:** [Exercise 4 — Eval Arena](04-eval-arena.md)
