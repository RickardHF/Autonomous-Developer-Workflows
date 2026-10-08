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

The manually triggered [Evaluate Agents & Skills](../.github/workflows/evaluate.yml) workflow:

1. Runs the repository-wide evaluation and captures per-definition failures separately.
2. Adds a workflow annotation and an **Open in GitHub Copilot** link for each successful result.
3. Publishes the scores and average in the job summary.
4. Generates and uploads the badge as a workflow artifact.
5. Commits `eval-badge.svg` back to the branch when its contents changed.