# Agentic Workshop

This repository hosts two workshops for getting more familiar with concepts in agentic workflows and customization.

The first part covers core concepts like creation of custom agents, skills, important aspects like limiting available tools, carefully writing instructions etc.

The second part covers more concepts in how to evaluate and how to orchestrate agents.

## Workshops

### GitHub Copilot Customization 101

Participants learn how to use GitHub Copilot effectively in a real repository by creating custom
skills and agents, shaping their behavior through focused instructions and tool access, and
recognizing when a customization is not working as intended. By the end of the workshop,
participants can diagnose common configuration problems, compare outcomes systematically, choose
models appropriately, and apply practical habits for managing context and token usage.

### Agentic Workflows & Evaluation

Participants learn how to move from individual customizations to reliable agentic workflows that can plan, execute, evaluate, and improve work. They design evaluation approaches for agents and skills, strengthen those evaluations over time, and connect them to CI/CD checks so quality becomes part of the development process. The workshop culminates in orchestrating multiple agents and bringing the pieces together into a repeatable workflow that can be assessed, maintained, and extended.


## Evaluation Status

[![Evaluation Results](https://rickardhf.github.io/Autonomous-Developer-Workflows/evaluation/eval-badge.svg)](https://rickardhf.github.io/Autonomous-Developer-Workflows/evaluation/eval-badge.svg)

The [Evaluate Agents & Skills](https://github.com/RickardHF/Autonomous-Developer-Workflows/actions/workflows/evaluate.yml)
workflow evaluates every push to `main`. GitHub Pages automatically displays the latest
**complete** evaluation above, labeled with its evaluated commit; no download or generated
Git commit is needed. Failed or incomplete evaluations leave the last complete image visible.
The workshop site updates independently. See
[automatic evaluation publishing](./docs/evaluator.md#automatic-evaluation-publishing).

The [PR regression check](https://github.com/RickardHF/Autonomous-Developer-Workflows/actions/workflows/evaluation-regression.yml) evaluates changed
`*.agent.md` files and complete skills under `.github/`, `.agents/`, and `.claude/`.
It compares freshly evaluated main and PR versions, failing if any score drops by **more than
one point** or evaluation is incomplete. It runs on non-draft PR creation and subsequent commits,
and when a draft becomes ready. GitHub's repository approval setting controls fork workflow runs.
See [merge-gate setup](./docs/evaluator.md#making-the-check-required-on-main) to require the check
on `main` after publishing the workflow.

## Getting Started

### Pre-Exercise Steps

#### Ensuring Setup Success

- [ ] Create your own copy of this workshop using **Use this template**, then select
      **Create a new repository**.
- [ ] Create a `copilot:plan-and-implement` label in the new repository.
- [ ] Invoke the `/description-to-github-issues` skill with GitHub Copilot to turn
      `src/DESCRIPTION.md`, `src/FUNCTIONAL_REQUIREMENTS.md`, and
      `src/TECHNICAL_REQUIREMENTS.md` into workshop issues.
- [ ] In `Settings` → `Actions` → `General`, enable
      **Allow GitHub Actions to create and approve pull requests**, then save.
- [ ] In `Settings` → `Pages`, set **Source** to **GitHub Actions**. In a template copy,
      update the evaluation image/viewer URLs and Actions workflow links in `README.md`
      and `docs/evaluator.md` to your own repository's Pages and Actions URLs; see
      [Pages setup](./docs/evaluator.md#pages-setup-and-recovery).

#### Setting up environments

- [ ] In the repository settings, select `Environments` and create an environment named
      `approval-required`.
- [ ] Configure the `approval-required` environment, enable **Required reviewers**, add yourself as a
      reviewer, and save the protection rules.

#### Familiarizing

- [ ] Check out the repository locally and familiarize yourself with its contents.
- [ ] On GitHub, open an issue and assign the `copilot:plan-and-implement` label to it.
- [ ] Open the `Actions` tab, confirm that the label started a workflow, and follow its progress. The
      workflow can take some time, so you can continue with other tasks and return to review its
      result later.

### Exercises

The exercises are in [GitHub Copilot Customization 101](./exercises/GitHub%20Copilot%20Customization%20101/)
and [Agentic Workflows & Evaluation](./exercises/Agentic%20Workflows%20%26%20Evaluation/).
The workshops are independent; your instructor will tell you which one to use.

Use the
[hosted workshop exercise browser](https://eficodedemoorg.github.io/Agent-Orchestration-and-Evaluation-Workshop/)
for a visual, self-paced interface. For local use, serve the repository over HTTP and open
`/learn/`; see the [workshop exercise browser README](./learn/README.md) for setup details.

## Repository content

The repository includes agent and skill definitions under `.agents/` and `.github/`, plus
additional client configuration under `.claude/`. Some definitions are intentionally weak so the
workshops have realistic examples to diagnose.

Reference documentation lives in the [/docs](/docs/) folder:

- [Copilot customization overview](/docs/copilot-customization.md) — the full landscape (instructions, prompts, agents, skills, MCP) and how the mechanisms combine
- [Agent Skills reference](/docs/skills.md) — SKILL.md anatomy, progressive disclosure, trigger tuning
- [Custom Agents reference](/docs/custom-agents.md) — frontmatter, tool restrictions, handoffs
- [Agent orchestration](/docs/agent-orchestration.md) — the GitHub Actions pipeline that turns labeled issues into ready-for-review PRs

The repository also contains GitHub Actions workflows that orchestrate agents. See
[Agent orchestration](./docs/agent-orchestration.md) for the current pipeline and its guardrails.

To manually prioritize the entire issue backlog, use **Actions -> AI Issue
Priority Triage -> Run workflow**. It assigns exactly one of `high`, `medium`,
`low`, or `blocked`, preserves unrelated labels, explains priority changes, and
groups cohesive tasks using reusable native parent/sub-issue relationships.
Check `dry_run` for a mutation-free preview. No separate Copilot token is needed;
see [manual issue triage](./docs/agent-orchestration.md#manual-ai-issue-priority-triage)
for authentication, operation, and recovery details.

Submitted approvals also activate **Classify Approved Trivial PRs** for
same-repository PRs targeting `main`. Copilot assesses whether the changes are
small and low-risk, including functional fixes. The workflow publishes its
classification but never merges or modifies a PR; use the normal review and
merge process.
See [review-triggered trivial PR classification](./docs/agent-orchestration.md#review-triggered-trivial-pr-classification)
for policy and guardrails.

The [/evaluator](/evaluator/) tool discovers agent and skill definitions in the supported
`.github/` and `.agents/` locations, evaluates them with AI, and assigns each one a score. It can
also format the results as an SVG badge, which is uploaded as a run-specific artifact.

See the [evaluator documentation](./docs/evaluator.md) for usage, arguments, evaluation flow, and badge generation.

The `src/` folder currently contains the description, functional requirements, and technical
requirements for the workshop's example application.

## McSquishy game preview

The browser-only McSquishy game preview lives in [`game/`](./game/). From the repository root,
run these commands inside that directory:

```sh
cd game
npm install
npm run dev
npm run build
npm run test
npm run typecheck
```

The default keyboard controls are documented in [`docs/CONTROLS.md`](./docs/CONTROLS.md).

The Vite development server serves a responsive, cream-and-ink page with an illustrated
pastel meadow and an expressive coral jelly blob. All artwork, styling, and fonts are
local or browser-provided; no backend or network assets are required. The canvas uses
an 800-by-450 logical scene with a backing buffer sized for the display's pixel density.

This is an **animated art preview**, not yet a playable platformer. McSquishy moves
automatically and responds to the keyboard controls; collision, lives, and playable levels
are not implemented.
Reduced-motion preferences disable new decorative bobbing, squash, blinking, cloud drift,
and UI effects while retaining the original movement demo.

Vitest runs rendering, preview lifecycle, canvas-sizing, and deterministic movement tests
in a Node environment, with no browser automation dependency.
