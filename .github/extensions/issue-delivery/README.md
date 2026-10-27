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
