# Evaluator

The evaluator uses GitHub Copilot to score agent and skill definitions from 1 to 10. It considers correctness, efficiency, readability, and maintainability, and returns a short reason for each score.

## Run an evaluation

From the `evaluator/` directory:

```bash
npm ci
npx tsx cli.ts evaluate --directory .. --json > eval_results.jsonl
```

Local runs require an authenticated GitHub Copilot SDK environment. Use the repository root as the directory so the evaluator can discover all definitions.

### Evaluation arguments

| Argument | Description |
| --- | --- |
| `--directory <path>` | Directory to search. Defaults to the current directory. |
| `--json` | Write one JSON result per line, suitable for later processing. |
| `--files <files...>` | Explicitly evaluates one or more agent files and/or skill directories. Accepts individual paths or comma-separated values in a single argument. |

Automatic discovery finds agents in `.github/agents/` and `.agents/agents/`, and skills in
`.agents/skills/` and `.github/skills/`. Each skill must contain a root `SKILL.md`. Explicit
`--files` targets also support `.claude/` definitions. Skill evaluation includes supporting
files, including hidden files, in addition to the root definition.

### Run a specific agent or skill

From the `evaluator/` directory, run the CLI with explicit file paths. This is the supported way to evaluate a single artifact or a small set of artifacts:

```bash
npx tsx cli.ts evaluate --files ../.github/agents/csharper.agent.md --json
```

To evaluate a single skill directory directly:

```bash
npx tsx cli.ts evaluate --files ../.agents/skills/generic-skill-name --json
```

You can also pass multiple explicit targets in one command:

```bash
npx tsx cli.ts evaluate --files \
  ../.github/agents/csharper.agent.md, \
  ../.agents/skills/generic-skill-name \
  --json
```

If the command succeeds, each JSON line should have this shape:

```json
{"fileName":"../.agents/skills/example/SKILL.md","score":8,"reasoning":"..."}
```

For an explicit `--files` run, `fileName` is relative to the directory where the evaluator
command runs. For an automatic `--directory` scan, it is relative to the search directory.
Evaluation failures are written to stderr; successful results continue to be emitted as JSONL.

## Pull request regression check

The [Evaluate Changed Agents & Skills](../.github/workflows/evaluation-regression.yml) workflow
publishes the check **Agent and skill score regression** on PRs targeting `main`.
It runs when a non-draft PR is opened, reopened, or receives new commits, and when a draft PR
becomes ready for review. Draft PRs do not run evaluation. Fork workflow runs follow GitHub's
built-in repository approval setting; the workflow has no custom fork-handling code.

The gate selects changed `*.agent.md` files anywhere within `.github/`, `.agents/`, and
`.claude/`, and skill directories identified by `SKILL.md` in those roots. Changes to any skill
supporting file, including hidden files and supporting-file deletions, select the complete skill
once. Other `.md` files are not automatically treated as agent definitions.

For each selected artifact, the runner evaluates its PR version and its version on the captured
current `main` revision. Both use the evaluator CLI and dependencies from that main revision.
The changed-file list covers the entire PR, not only the latest commit, and Git-detected
definition renames retain their previous path as the baseline.

| Situation | Outcome |
| --- | --- |
| Score improves, stays equal, or drops by exactly 1 point | Pass |
| Score drops by more than 1 point | Fail |
| New artifact absent from main | Previous score is 0; evaluate the new artifact |
| Deleted agent or entire skill | Report deletion; exclude it from score comparison |
| Deleted supporting file in a surviving skill | Evaluate the remaining complete skill |
| No relevant surviving artifact changes | Pass without installing evaluator dependencies or making Copilot requests |
| Failed evaluation, malformed JSON, invalid scores, missing/duplicate/unexpected results | Fail, even if the evaluator process exits successfully |

The workflow captures exact main and PR head commit SHAs, cancels obsolete runs for the same
PR, and publishes per-artifact scores, changes, and both sets of reasoning in its summary.
Its evidence artifact contains the selection manifest, raw JSONL, comparison results, and
evaluation diagnostics. It does not commit badges or scores to PR branches.

Scores are AI-generated and may vary between runs. Evaluating both snapshots provides a
same-run comparison but consumes Copilot requests for both versions of existing artifacts.
Scores are not averaged across artifacts, and failed scores are not automatically retried
until they pass.

The regression runner uses Node.js 24's native TypeScript support. Its deterministic tests do
not require Copilot authentication:

```bash
cd evaluator
npm run test:regression
npm run typecheck
npm run build
```

The existing `npm test` command also runs live evaluator tests and requires an authenticated
Copilot environment.

### Restricting fork workflow runs

Use GitHub's built-in repository setting in **Settings -> Actions ->
General -> Approval for running fork pull request workflows from contributors**, require
approval for **all external contributors**. Users without write access cannot execute fork PR
workflows without a maintainer's approval. PR handling remains unchanged; no custom guards are
needed. Configure this setting separately in new template copies.

### Making the check required on main

A failed workflow does not block merges unless GitHub requires its check. Publish the new
workflow and verify a non-draft same-repository PR reports **Agent and skill score regression**
before enabling enforcement; requiring an unpublished check can lock the branch.

In **Settings -> Rules -> Rulesets**, create an active branch ruleset targeting `main`.
Enable **Require status checks to pass**, select **Agent and skill score regression**,
and enable **Require branches to be up to date before merging**. The latter ensures a passing
comparison against an outdated main revision cannot authorize a merge.

Do not add workflow-level path filters: PRs without artifact changes still need a successful
no-op check rather than a required check left pending. Keep the required context aligned with
the workflow job's `name` when changing the workflow.

## Create a badge

Pass the JSONL results to the `badge` command:

```bash
npx tsx cli.ts badge \
  --input eval_results.jsonl \
  --output ../eval-badge.svg \
  --date "$(date -u +%Y-%m-%d)"
```

The badge contains a score row for each valid result and a rounded average. Its arguments are:

| Argument | Default | Description |
| --- | --- | --- |
| `--input <file>` | `eval_results.jsonl` | JSONL evaluation results. |
| `--output <file>` | `../eval-badge.svg` | SVG file to create. |
| `--date <date>` | Today | Date shown on the badge. |

### Automatic badge artifacts

The [Evaluate Agents & Skills](../.github/workflows/evaluate.yml) workflow runs on
every push to `main`, without path filters, and can also be started with
**Actions -> Evaluate Agents & Skills -> Run workflow**. New runs cancel
in-progress runs of this workflow for the same source branch.

1. Evaluates the exact triggering commit and captures per-definition failures separately.
2. Adds a workflow annotation and an **Open in GitHub Copilot** link for each successful result.
3. Publishes the scores, average, and evaluated commit in the job summary.
4. Generates a fresh SVG labeled with the date and evaluated commit, then uploads
   it as the run-specific `eval-badge` workflow artifact linked in the summary.

Badges are snapshots, not a guarantee of the current `main` state. A separate
freshness check followed by a badge push cannot atomically guard against `main`
advancing at the push boundary. The workflow therefore does not publish a shared
badge or update `evaluation-results`; it uses `GITHUB_TOKEN` with `contents: read`
and never writes to repository branches. Any older output branch is left untouched
and should not be treated as current. The existing GitHub Pages deployment from
`main` is unaffected.

Manual runs on other branches also generate snapshot artifacts and summaries.
Badge generation and upload are success-gated; an artifact uploaded before a
later cancellation still represents only its evaluated snapshot. Individual
definition errors retain the existing warning behavior: successful scores can
still produce a badge if the overall run succeeds. This workflow does not
introduce a stricter completeness gate.

The tracked root `eval-badge.svg` is not updated by automation; the local CLI's
default badge output path remains unchanged.

GitHub does not trigger `push` workflows for writes authenticated with
`GITHUB_TOKEN`. Ordinary user pushes and PR merges trigger evaluation; automation
that updates main using `GITHUB_TOKEN` must explicitly dispatch evaluation if it
also needs a new badge.

After installing the evaluator dependencies, run the evaluation workflow tests
from the repository root:

```bash
node --test .github/scripts/evaluation-workflow.test.cjs
```

These tests execute workflow scripts with mocked evaluation and disposable local
Git fixtures, including a concurrent `main` advance. They do not require Copilot
authentication or write to GitHub.