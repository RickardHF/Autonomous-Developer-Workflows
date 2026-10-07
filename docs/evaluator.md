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

The evaluator finds agents in `.github/agents/` and `.agents/agents/`, and skills in `.agents/skills/` and `.github/skills/`. Each skill must contain a root `SKILL.md`.

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