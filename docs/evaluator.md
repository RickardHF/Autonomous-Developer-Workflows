# Evaluator

The evaluator uses GitHub Copilot to score agent and skill definitions from 1 to 10. It considers correctness, efficiency, readability, and maintainability, and returns a short reason for each score.

## Definition validation and quality criteria

Before making a Copilot request, the evaluator checks that each agent definition or root
`SKILL.md` starts with YAML frontmatter enclosed by standalone opening and closing `---` lines.
LF and CRLF line endings and an optional UTF-8 BOM are supported. The frontmatter must be a
valid YAML mapping without duplicate keys.

| Definition | Required frontmatter fields |
| --- | --- |
| Agent | `description` |
| Skill | `name`, `description` |

Required fields must be nonempty strings; missing, null, blank, or non-string values are invalid.
Agent `name`, `model`, and `tools` remain optional. Supporting Markdown files do not need
frontmatter, and this check is not a general Markdown style linter.

Invalid delimiters, YAML, or required fields produce **score 1** with an explanation of the
validation failure, without calling Copilot. This is an ordinary evaluation result, including
in JSONL output, not a runtime failure. Valid definitions proceed to AI quality scoring:

- **Agents:** Model capability should fit the task, without being underpowered or unnecessarily
  large/costly. Tools should cover the required capabilities without unnecessarily broad access.
  An omitted model inherits the caller's default and is not penalized just for being omitted.
  Omitting `tools` or using a wildcard enables all tools; an empty list enables none. Shell tools
  can grant editing capabilities even without an explicit editing tool.
- **Skills:** The name and description should accurately identify what the skill does and when
  to use it, matching its instructions and supporting artifacts. The CLI also compares `name`
  exactly, including case, with the skill folder's basename. A mismatch lowers the **AI quality
  score** and should be explained in its reasoning; it does not automatically force score 1 or
  incur a fixed numeric penalty.

These criteria are task-aware rather than a fixed model ranking or tool catalog. Validation
failures are deterministic; AI quality scores and reasoning may vary between runs. Task
performance evaluation is unchanged.

### Programmatic skill evaluation

`evaluateSkillDefinition(skillDefinition, skillArtifacts?, skillDirectory?)` accepts the actual
skill directory as an optional third argument:

```typescript
const result = await evaluateSkillDefinition(skillMarkdown, artifacts, "/path/to/example-skill");
```

Existing calls with just the definition, or with supporting artifacts, remain supported. Without
a directory, the evaluator assesses metadata quality but explicitly marks folder matching as
unchecked; it does not infer a folder name. The CLI supplies the directory for both discovery
and explicit `--files` evaluations.

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

Quality scores for valid definitions are AI-generated and may vary between runs; frontmatter
validation failures always score 1. Evaluating both snapshots provides a
same-run comparison but consumes Copilot requests for both versions of existing artifacts.
Scores are not averaged across artifacts, and failed scores are not automatically retried
until they pass.

The regression runner uses Node.js 24's native TypeScript support. The frontmatter validation
and rubric/context tests use a mocked SDK. These deterministic suites do not require Copilot
authentication:

```bash
cd evaluator
npm run test:definitions
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

### Automatic evaluation publishing

The [Evaluate Agents & Skills](https://github.com/RickardHF/Autonomous-Developer-Workflows/actions/workflows/evaluate.yml) workflow runs on
every push to `main`, without path filters, and can also be started with
**Actions -> Evaluate Agents & Skills -> Run workflow**. New runs cancel
in-progress runs of this workflow for the same source branch.

1. Evaluates the exact triggering commit and captures per-definition failures separately.
2. Adds a workflow annotation and an **Open in GitHub Copilot** link for each successful result.
3. Publishes the scores, average, and evaluated commit in the job summary.
4. Validates that every discovered definition has exactly one valid result.
   Missing, duplicate, unexpected, malformed, or invalid results fail the run;
   runtime errors cannot silently produce a partial published badge. Invalid
   frontmatter still produces an ordinary score-1 result.
5. Generates a fresh date/commit-labeled SVG and uploads an `evaluation-output`
   bundle containing `eval-badge.svg`, `results.jsonl`, and `snapshot.json`.
   Raw results and errors are also retained in `evaluation-diagnostics` on failure.
6. Links directly to the public SVG and embeds the latest published image in the
   job summary. Developers do not need to download an artifact to see the scores.
   If Pages is not enabled or its URL lookup fails, the summary warns explicitly
   without invalidating the complete evaluation; recover Pages and publish the
   retained bundle without repeating AI evaluation.

The [Publish Game & Evaluation](../.github/workflows/pages.yml) workflow installs
the locked game dependencies, builds `game/dist`, and deploys **only the built
McSquishy game and evaluation outputs**, with `.nojekyll`. The game opens directly
at the existing Pages root; relative asset URLs support repository Pages paths
and custom-domain roots. The workshop dashboard, exercises, and repository
source files are not published. Workshop sources remain available for local use.

Main pushes update the game independently of evaluation. Successful main
evaluations trigger another deployment to update the scores. Deployments are
serialized, check out current main, and select the newest eligible complete main
evaluation rather than blindly publishing whichever run finished last. A late
evaluation cannot roll the game back to the evaluated revision.

The README embeds the permanent `evaluation/eval-badge.svg` Pages URL.
`evaluation/results.jsonl` and `evaluation/snapshot.json` expose the scores and
source metadata directly. The published snapshot is carried forward during
site-only updates even after its Actions artifact expires. A failed or incomplete
evaluation does not remove the last complete image; initial absence of any
complete evaluation is shown explicitly as pending.

Actions artifacts retain run-specific evaluation bundles, diagnostics, and PR
comparison evidence only for their configured retention period. Pages preserves
the **latest complete main result**, not permanent history for every run. Do not
delete the published `evaluation/snapshot.json` during game-only updates: it is
the carry-forward source when the original artifact has expired. Losing both the
published snapshot and its artifact can require a new evaluation to recover.

The badge is the **latest complete evaluation**, not a guarantee that its source
SHA equals main at every instant. Its date/commit label identifies the evaluated
revision. Normal Pages and GitHub image-cache propagation may delay a refresh.
Manual runs on other branches retain their diagnostic snapshots but cannot
update the public image. Failed, cancelled, foreign-repository, or unrelated
revision runs cannot supply the published snapshot.

The staging command receives the built game through `--game-directory`, requires
a nonempty `index.html`, and rejects a game-supplied `evaluation/` directory.
Missing builds, invalid published snapshots, and publication API failures fail
the deployment explicitly rather than replacing the live site with lost or
partial evaluation data.

The PR regression check is independent of this publication pipeline: it still
evaluates main and PR definitions freshly in the same run, without reading a
badge, Pages JSON, or any saved Actions artifact.

The tracked root `eval-badge.svg` is not updated by automation; the local CLI's
default badge output path remains unchanged. Neither workflow commits output,
opens badge-update PRs, writes a results branch, or bypasses main protection.
Any older output branch is left untouched.

GitHub does not trigger `push` workflows for writes authenticated with
`GITHUB_TOKEN`. Ordinary user pushes and PR merges trigger evaluation; automation
that updates main using `GITHUB_TOKEN` must explicitly dispatch evaluation if it
also needs a new evaluation. Site-only automation can explicitly dispatch
`pages.yml`.

### Pages setup and recovery

After the workflows reach `main`, set **Settings -> Pages -> Source** to
**GitHub Actions** once. Keep the `github-pages` environment restricted to main,
without recurring reviewer approval, and preserve the existing site URL.
For a template copy, update the README game link to your own Pages root and
replace the evaluation image/link with
`https://<owner>.github.io/<repository>/evaluation/eval-badge.svg`, or your Pages
custom-domain equivalent. Evaluation summaries obtain the actual Pages URL.
Also replace the repository-specific Actions links in `README.md` and this
document with your own
`https://github.com/<owner>/<repository>/actions/workflows/evaluate.yml` and
`https://github.com/<owner>/<repository>/actions/workflows/evaluation-regression.yml`
URLs, so template users open their own runs rather than the upstream repository.

Run **Evaluate Agents & Skills** on main to create the first complete snapshot.
**Publish Game & Evaluation** can also be dispatched to refresh the game or
recover a deployment without rerunning AI evaluation:

```bash
gh workflow run evaluate.yml --ref main
gh workflow run pages.yml --ref main
```

Confirm the Pages root opens McSquishy directly, its JavaScript, stylesheet, and
favicon load beneath the repository URL prefix, and the README image renders
without downloads. The SVG, `results.jsonl`, and `snapshot.json` stay under
`/evaluation/`; `/learn/` and the exercise files are no longer deployed.
Publication errors fail explicitly and leave the previous deployment intact.
Recover by rerunning `pages.yml` after fixing the build or publishing error;
rerun evaluation only if no complete snapshot or unexpired bundle remains.
Do not delete the current deployment or weaken main protection during recovery.

After installing the evaluator dependencies, run the evaluation workflow tests
from the repository root:

```bash
npm --prefix evaluator run test:workflows
```

These tests execute workflow scripts with mocked evaluation, publication/API
fixtures, and disposable local Git repositories. They cover complete SVG output,
retaining results on failures and artifact expiration, out-of-order runs,
game-only payloads, and missing-build failures. They do not require Copilot
authentication or write to GitHub.