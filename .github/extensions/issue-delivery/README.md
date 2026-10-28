# Issue delivery dynamic workflow

Registered name: `issue-delivery` (project extension; run `extensions_reload` after changes).

Input:

```json
{
  "issueUrl": "https://github.com/RickardHF/Autonomous-Developer-Workflows/issues/42"
}
```

Invoke with `run_dynamic_workflow` using this name and input. This definition is
session-scoped, not a GitHub Actions workflow or an app-wide automation. Its source
is preserved next to this document for inspection and re-registration.

The workflow uses five fresh workflow-agent contexts, not five sidebar sessions.
It captures the current branch and HEAD in this repository; it never creates or
switches branches. Start with a clean checkout and keep other writers out of it
until the run ends.

1. A read-only planner captures acceptance criteria and an implementation plan.
2. The sole implementation agent edits and validates the shared checkout.
3. An issue-coverage reviewer checks actual behavior against the captured issue,
   including any issue requirement missed by the plan.
4. A separate static quality/security reviewer runs concurrently with stage 3,
   without seeing its findings.
5. A synthesizer reads both reviews and recommends successful, unsuccessful, or
   inconclusive. A deterministic gate prevents an optimistic summary from
   overriding missing reviews, unverified acceptance, failed checks, changed issue
   requirements, or unresolved blocking/high/critical findings.

Agents receive paths to local issue, plan, implementation, and review artifacts,
not predecessor conversation history. The coordinator persists structured outputs,
the tracked-file patch, a hashed new-file manifest, review fingerprint, and a final
Markdown report under `<repo>/.git/issue-delivery/<run-id>/` (untracked, so the checkout stays clean)

New files are explicitly included in review instructions.

The workflow does not commit, push, create a PR, modify the GitHub issue, or
automatically apply review fixes. Source changes remain unstaged on the original
branch. A blocked plan ends without starting implementation. Failed implementation
output is recorded explicitly and any partial changes are still reviewed; success
is disallowed.

Resume uses durable step outputs and agent memoization; completed agents are not
restarted. A branch, HEAD, source, index, or protected-artifact change detected at
a stage boundary stops the run instead of reviewing stale content. A crash after
source edits but before the implementation checkpoint may require a new run after
manual reconciliation. Do not clear journals or undo source changes blindly.

Read-only boundaries are agent instructions plus before/after fingerprints, not
an OS sandbox or an exclusive repository lock. Ignored build output is outside
the fingerprint. The implementation is instructed not to change ignored source
or submodule worktrees; reviewers must report scope they cannot verify.

The adjacent `workflow.test.mjs` uses mocked Git/GitHub, filesystem, and agents to exercise
ordering, review concurrency, artifact handoffs, failure handling, recommendation
gates, and resume safety without changing the repository or running live agents:

```sh
node --test .github/extensions/issue-delivery/workflow.test.mjs
```

## Run dashboard

The same project extension also declares the **Issue delivery runs** canvas
(`issue-delivery-runs`). After reloading the extension provider with
`extensions_reload` (or restarting the Copilot session), ask Copilot to
**"Open the issue-delivery dashboard."** The canvas takes an empty input object.
It does not start a delivery run or require a clean checkout just to inspect
existing artifacts.

The dashboard uses plain HTML, CSS, and JavaScript with no framework, build
step, CDN, or additional package installation. Its extension-owned HTTP server
binds only to `127.0.0.1` on an ephemeral port with a private per-panel URL.
Closing the panel stops that panel's server; closing the session also stops
the observer. The only canvas action, `list_runs`, reads recorded run summaries.
There are no start, resume, pause, cancel, edit, or delete controls.

Select a run to see its issue/branch identity, recorded runtime state and
delivery recommendation. The connected **Prepare → Plan → Implement → Review →
Summarize** path follows the workflow's phase metadata. Click a phase to inspect
its artifacts, or use the arrow keys, Home and End with the phase tabs focused.
The Review phase also exposes its two independent, parallel reviewers.

Phase colors have explicit text labels: **green** means completed, **gray**
means not started/skipped (or explicitly unknown), **red** means a runtime/agent
error or recorded failed validation/review, **blue** means in progress, and
**yellow** means closed unfinished, including blocked or unavailable output and
a phase interrupted by a paused, halted or cancelled run. A completed phase is
not a promise of a successful final delivery recommendation. Stale active
phases are unknown, not falsely shown as still executing.
An actively executing resumed phase does not inherit failed or incomplete
artifact outputs from an earlier attempt.

Each artifact has an independent collapsible view with **Preview** and **Raw**
modes. Files load when expanded; background refresh preserves the selected
phase, expanded artifacts, mode and unchanged nested preview contents. Activity
is filtered to the selected phase. Runtime observations and unknown future
files remain accessible under **Run-level & other files**.

Artifacts are grouped by their producing phase: issue/context under Prepare,
plan under Plan, implementation/patch and compact reviewed-checkout metadata under Implement,
both review outputs under Review, and report/result/synthesis/decision gate
under Summarize. The inspector supports JSON, Markdown, patches and text files;
unknown JSON gets a generic view. The smaller `result.json` written when planning
is blocked belongs to Plan instead, since Summarize never ran.

Known artifacts have document-style previews rather than generic property/value
layouts:

- **Captured issue** shows the issue number/title, clickable URL, upper-right
  update time, rendered Markdown body, and individual comments with their own
  links and update times. Captured comments do not include author metadata.
- **Implementation plan** has a top status badge and titled sections.
  Acceptance criteria use **ID**, **Requirements**, and **Verification** columns.
- **Implementation result** starts with a changed-file list: added files are
  green, modified/renamed files yellow, and deleted files red, with explicit
  text statuses. The implementation and both reviews display readable output
  reports without wrapper keys or property-name headings.
- **Source changes** uses a GitHub-style unified diff with collapsible file
  headers, old/new line numbers, hunk context, and added/removed lines. Binary
  and mode-only changes remain identifiable; unsupported patches show a
  notice and recorded text rather than an invented diff.
- **Reviewed checkout** is a metadata strip above the Implement artifacts,
  without a repeated changed-file list. Its original JSON remains accessible
  in **Raw checkout metadata**.
- **Final result** and **Review synthesis** use titled sections and findings
  tables. Synthesis tables show source, ID, disposition, and reason; reviewer
  tables retain severity, location, confidence, blocking status, and expandable
  evidence.

There is no standalone **New files** panel in Implement. Its original manifest
remains under **Run-level & other files** and contributes new-file statuses.
The recorded patch contains tracked-file changes only: the manifest stores
paths and hashes, **not new-file contents**. The dashboard does not read the
current checkout to manufacture a historical new-file diff. Missing or
unsupported evidence produces an explicit unavailable status or notice.
Related patch/manifest changes refresh file statuses even when the primary
implementation output is unchanged.

### Progress across sessions

Workflow observation APIs are scoped to the owning Copilot session. Whenever
this extension is loaded, its observer uses those supported APIs to record its
own `issue-delivery` runs, even if no dashboard panel is open. It writes only a
separate `dashboard.json` under `<git-dir>/issue-delivery/<run-id>/`, resolving
`<git-dir>` with `git rev-parse --absolute-git-dir` just like the workflow.
This keeps tracked files and protected delivery handoffs untouched.

Another session in the same checkout can read those snapshots. Other
worktrees, clones, and machines have separate storage and are not aggregated.
The observer reconciles every five seconds and on runtime invalidations; the
page refreshes every three seconds while visible. Observer failures appear in
the owning session's log and dashboard rather than changing the delivery result.

`dashboard.json` is a versioned display contract (`schemaVersion: 1`), containing
run/owner identity, revision and timestamps, runtime status/error, phases,
agent labels/status, and at most 200 recent progress records. Progress text is
limited to 4,000 characters per record, with truncation indicated. It does not
copy agent prompts or full conversations, and is written by private, atomic
file replacement.

**Runtime state is not the delivery verdict.** A runtime `completed` run can
have an `unsuccessful` or `inconclusive` recommendation. A nonterminal
`pending`/`running` snapshot without an observation for 30 seconds is shown as
stale, with its last known state; staleness does not prove a crash or ongoing
execution. Paused and halted attempts remain recorded as such until a resume
is observed.

Older runs without compatible snapshots remain **artifact-only**: their
artifacts and recommendation are inspectable, but phase timings and live
status are unknown. Empty run directories are shown without inventing an
outcome. The observer can recover supported runtime history if the owning
session is opened again. The dashboard never reads Copilot's internal databases.

### JSON artifact contracts

JSON files do **not** all contain the same properties. Their current contracts
are defined by the schemas and save sites in `workflow.mjs`:

| Artifact | Main fields / shape |
|---|---|
| `context.json` | Run, repository, checkout, branch, starting revision and requirement digest |
| `issue.json` | Number, title, nullable body, URL, update timestamp and comments |
| `plan.json` | Status, goal, scope, acceptance criteria, steps, mitigations, rollback, validation requirement and blockers |
| `implementation.json` | `available`, nullable `output`, `changedFiles`; output holds status, summary, changes, checks, deviations and blockers |
| Both `*-review.json` files | `available`, nullable `output`; output holds verdict, summary, coverage, findings, checks and criteria |
| `decision-gate.json` | Maximum recommendation, failures and uncertainties |
| `summary.json` | Recommendation, summary, rationale, finding dispositions, remaining risks and next steps |
| `result.json` | Full delivery result, or a smaller blocked-planning result with `stage`, `blockers`, `recommendation` and artifact path |
| `review-snapshot.json` | Branch, revision, fingerprint, changed files and review instructions |
| `untracked-files.json` | Array of entries with path, mode, SHA-256 and symlink flag |
| `dashboard.json` | Versioned runtime observations, separate from delivery artifacts |

These are per-artifact shapes, not a forever-stable universal schema. Existing
delivery artifacts are not versioned, and partial runs may omit files.
The SDK does not enforce every JSON Schema keyword; readers must tolerate
extra fields. Contract warnings, unavailable outputs, and malformed JSON are
visible in the inspector, and Raw preserves unknown properties and original text.

The Markdown preview supports headings, paragraphs, ordered/unordered lists,
inline code, emphasis, absolute HTTP(S) links, fenced code and tables. HTML is
displayed as text; images and remote assets are not fetched. Relative, file,
credential-bearing and unsafe-scheme links are not activated. Large Markdown
and deeply nested/long JSON previews are bounded with a visible notice; Raw
retains the full artifact within the 2 MiB file display limit.

The server exposes only supported, regular text artifacts inside canonical run
directories. It rejects symlinks, path traversal, cross-origin data requests,
unknown capability URLs, oversized files and all non-GET requests. It does not
serve arbitrary `.git` files or execute commands on behalf of the page.

### Dashboard checks

Run the adjacent deterministic tests without running live agents:

```sh
node --test .github/extensions/issue-delivery/workflow.test.mjs .github/extensions/issue-delivery/dashboard.test.mjs
```

The dashboard tests use temporary artifacts, a mocked owning-session SDK,
a small dependency-free DOM fixture, and real loopback HTTP requests.
They cover rendered issue/comment documents, exact acceptance-table columns,
output and synthesis layouts, diff parsing/line numbers, file statuses,
related-artifact refresh and run-switch races, schema variants, legacy/partial runs,
cross-session snapshots, stale progress, observer failures, history pagination,
resume and lifecycle handling, phase order/dependencies, artifact ownership,
the five phase colors, incomplete outputs, read-only endpoints, and rendering
boundaries.
