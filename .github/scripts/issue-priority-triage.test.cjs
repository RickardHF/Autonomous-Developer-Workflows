const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { PRIORITIES, collectSnapshot, validatePlan, extractPlan, isStagedRun, applyPlan, summary } = require("./issue-priority-triage.cjs");

const REPOSITORY = "example/project";
const RUN_ID = "123";
const RUN_URL = `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`;
const REASON = "The current repository needs this foundation to unlock the next implementation work.";
const EVIDENCE = "The issue explicitly requires the unfinished implementation described by this prerequisite.";
const clone = (value) => structuredClone(value);

function fakeGithub(records = [], initialLabels = PRIORITIES) {
  let tick = 0;
  let nextComment = 1000;
  const github = {
    sourceSha: "a".repeat(40),
    calls: [],
    issues: new Map(),
    labels: new Map(initialLabels.map((name) => [name, { name }])),
    beforeRequest: null,
    add(record) {
      const issue = {
        id: 10000 + record.number,
        number: record.number,
        title: `Implement task ${record.number}`,
        body: "A bounded implementation task with verifiable acceptance criteria.",
        state: "open",
        state_reason: null,
        labels: [],
        user: { login: "maintainer" },
        repository_url: `https://api.github.com/repos/${REPOSITORY}`,
        updated_at: "2026-10-07T00:00:00Z",
        comments: [],
        blockedBy: [],
        parent: null,
        ...clone(record),
      };
      issue.labels = issue.labels.map((label) => typeof label === "string" ? { name: label } : label);
      issue.comments = issue.comments.map((comment, index) => ({
        id: 100 + index, body: "Maintainer context for this issue.", user: { login: "maintainer" },
        updated_at: "2026-10-07T00:00:00Z", ...comment,
      }));
      github.issues.set(issue.number, issue);
      return issue;
    },
    writes() {
      return github.calls.filter(({ route }) => !route.startsWith("GET "));
    },
    touch(issue) {
      issue.updated_at = `2026-10-07T00:00:${String(++tick).padStart(2, "0")}Z`;
    },
    raw(issue) {
      const children = [...github.issues.values()].filter((item) => item.parent === issue.number);
      return {
        ...clone(issue),
        parent_issue_url: issue.parent ? `https://api.github.com/repos/${REPOSITORY}/issues/${issue.parent}` : null,
        sub_issues_summary: { total: children.length },
        issue_dependencies_summary: { blocked_by: issue.blockedBy.length },
      };
    },
    async request(route, parameters) {
      github.calls.push({ route, parameters: clone(parameters) });
      if (github.beforeRequest) await github.beforeRequest(route, parameters);
      const [method, path] = route.split(" ");
      const suffix = path.replace("/repos/{owner}/{repo}", "");
      const issue = github.issues.get(parameters.issue_number);
      const failure = (status, message) => { throw Object.assign(new Error(message), { status }); };
      let data;
      if (method === "GET") {
        if (suffix === "") data = { default_branch: "main" };
        else if (suffix === "/commits/{ref}") data = { sha: github.sourceSha };
        else if (suffix === "/issues") data = [...github.issues.values()]
          .filter((item) => parameters.state === "all" || item.state === parameters.state).map(github.raw);
        else if (suffix === "/labels") data = [...github.labels.values()];
        else if (!issue) failure(404, "Issue not found");
        else if (suffix === "/issues/{issue_number}") data = github.raw(issue);
        else if (suffix === "/issues/{issue_number}/comments") data = clone(issue.comments);
        else if (suffix === "/issues/{issue_number}/sub_issues") data = [...github.issues.values()]
          .filter((item) => item.parent === issue.number).map(github.raw);
        else if (suffix === "/issues/{issue_number}/dependencies/blocked_by") data = issue.blockedBy
          .map((blocker) => github.raw(github.issues.get(blocker)));
        else if (suffix === "/issues/{issue_number}/parent") {
          if (!issue.parent) failure(404, "No parent");
          data = github.raw(github.issues.get(issue.parent));
        } else throw new Error(`Unexpected read ${route}`);
        if (Array.isArray(data)) {
          const start = ((parameters.page ?? 1) - 1) * (parameters.per_page ?? 100);
          data = data.slice(start, start + (parameters.per_page ?? 100));
        }
      } else if (method === "POST" && suffix === "/labels") {
        github.labels.set(parameters.name, { name: parameters.name });
        data = github.labels.get(parameters.name);
      } else if (method === "POST" && suffix === "/issues") {
        data = github.raw(github.add({
          number: Math.max(0, ...github.issues.keys()) + 1,
          title: parameters.title, body: parameters.body, user: { login: "github-actions[bot]" },
        }));
      } else if (method === "POST" && suffix === "/issues/{issue_number}/comments") {
        const comment = {
          id: nextComment++, body: parameters.body, user: { login: "github-actions[bot]" },
          updated_at: "2026-10-07T01:00:00Z",
        };
        issue.comments.push(comment);
        github.touch(issue);
        data = comment;
      } else if (method === "PATCH" && suffix === "/issues/comments/{comment_id}") {
        const owner = [...github.issues.values()].find((item) =>
          item.comments.some((comment) => comment.id === parameters.comment_id));
        const comment = owner.comments.find((item) => item.id === parameters.comment_id);
        comment.body = parameters.body;
        github.touch(owner);
        data = comment;
      } else if (method === "POST" && suffix === "/issues/{issue_number}/labels") {
        for (const label of parameters.labels) {
          assert.ok(github.labels.has(label), `Undefined label ${label}`);
          if (!issue.labels.some((item) => item.name === label)) issue.labels.push({ name: label });
        }
        github.touch(issue);
        data = issue.labels;
      } else if (method === "DELETE" && suffix === "/issues/{issue_number}/labels/{name}") {
        issue.labels = issue.labels.filter((label) => label.name !== parameters.name);
        github.touch(issue);
        data = issue.labels;
      } else if (method === "POST" && suffix === "/issues/{issue_number}/sub_issues") {
        const child = [...github.issues.values()].find((item) => item.id === parameters.sub_issue_id);
        assert.equal(parameters.replace_parent, false);
        assert.ok(child, "Sub-issue must use its database ID");
        if (child.parent && child.parent !== issue.number) failure(422, "Existing parent");
        child.parent = issue.number;
        github.touch(child);
        github.touch(issue);
        data = github.raw(child);
      } else throw new Error(`Unexpected mutation ${route}`);
      return { data: clone(data) };
    },
    async paginate(route, parameters) {
      const all = [];
      for (let page = 1; ; page++) {
        const { data } = await github.request(route, { ...parameters, page });
        all.push(...data);
        if (data.length < parameters.per_page) return all;
      }
    },
  };
  records.forEach(github.add);
  return github;
}

async function fixture(records = [{ number: 1 }], initialLabels) {
  const github = fakeGithub(records, initialLabels);
  const snapshot = await collectSnapshot({ github, repository: REPOSITORY, runId: RUN_ID });
  const plan = {
    version: 1,
    snapshot_id: snapshot.snapshot_id,
    decisions: snapshot.issues.map((issue) => ({
      issue_number: issue.number,
      priority: issue.blocked_by.some((blocker) => blocker.state === "open") ? "blocked" : "high",
      reason: REASON,
      blockers: issue.blocked_by.filter((blocker) => blocker.state === "open")
        .map((blocker) => ({ issue: blocker.reference, evidence: EVIDENCE })),
    })),
    groups: [],
  };
  const apply = (overrides = {}) => applyPlan({
    github, snapshot, plan, runUrl: RUN_URL, pause: async () => {}, ...overrides,
  });
  return { github, snapshot, plan, apply };
}

function group(children, parent = null, key = "foundation") {
  return {
    key, parent_issue_number: parent, children, reason: REASON,
    new_parent: parent === null ? {
      title: "Deliver the shared foundation", body: REASON, priority: "high", reason: REASON, blockers: [],
    } : null,
  };
}

test("collects paginated issue/comment context, closed prerequisites, and excludes PRs", async () => {
  const records = Array.from({ length: 101 }, (_, index) => ({ number: index + 1 }));
  records[0].comments = Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }));
  records.push({ number: 102, pull_request: { url: "a PR" } }, { number: 103, state: "closed" });
  records[0].blockedBy = [103];
  const { github, snapshot } = await fixture(records);
  assert.equal(snapshot.issues.length, 101);
  assert.equal(snapshot.issues[0].comments.length, 101);
  assert.equal(snapshot.closed_issues[0].number, 103);
  assert.equal(snapshot.issues[0].blocked_by[0].state, "closed");
  assert.ok(github.calls.some((call) => call.route.endsWith("/issues") && call.parameters.page === 2));
  assert.ok(github.calls.some((call) => call.route.endsWith("/comments") && call.parameters.page === 2));
  assert.deepEqual(github.writes(), []);
});

test("reconciles every starting priority subset and preserves unrelated labels", async (t) => {
  for (let subset = 0; subset < 16; subset++) {
    await t.test(`managed subset ${subset}`, async () => {
      const before = PRIORITIES.filter((_, index) => subset & (1 << index));
      const { github, apply } = await fixture([{ number: 1, labels: ["bug", "copilot:plan-and-implement", ...before] }]);
      await apply();
      assert.deepEqual(github.issues.get(1).labels.map((label) => label.name).sort(),
        ["bug", "copilot:plan-and-implement", "high"]);
      assert.equal(github.issues.get(1).comments.length, before.length === 1 && before[0] === "high" ? 0 : 1);
      if (github.issues.get(1).comments.length) {
        const comment = github.issues.get(1).comments[0];
        assert.match(comment.body, /Application:\*\* completed/);
        assert.ok(comment.body.includes(REASON));
        const writes = github.writes();
        assert.ok(writes.findIndex((call) => call.route.endsWith("/comments")) <
          writes.findIndex((call) => call.route.includes("/labels")));
      }
      assert.ok(github.writes().every((call) => !call.route.startsWith("PUT ")));
      assert.ok(github.writes().filter((call) => call.route.startsWith("DELETE "))
        .every((call) => PRIORITIES.includes(call.parameters.name)));
    });
  }
});

test("creates only missing label definitions and leaves existing definitions alone", async () => {
  const { github, apply } = await fixture([{ number: 1 }], ["high", "bug"]);
  await apply();
  assert.deepEqual(github.writes().filter((call) => call.route.endsWith("/labels") && call.parameters.name)
    .map((call) => call.parameters.name).sort(), ["blocked", "low", "medium"]);
});

test("fails before writes for a case-insensitive managed-label collision", async () => {
  const { github, apply } = await fixture([{ number: 1 }], ["High"]);
  await assert.rejects(apply(), /exact lowercase/);
  assert.deepEqual(github.writes(), []);
});

test("preserves unrelated labels added while an issue is being updated", async () => {
  const { github, apply } = await fixture([{ number: 1, labels: ["low", "bug"] }]);
  github.beforeRequest = (route) => {
    if (route.startsWith("POST ") && route.endsWith("/comments")) {
      github.issues.get(1).labels.push({ name: "added-concurrently" });
    }
  };
  await apply();
  assert.deepEqual(github.issues.get(1).labels.map((item) => item.name).sort(), ["added-concurrently", "bug", "high"]);
});

test("no label mutation occurs when reasoning publication fails", async () => {
  const { github, apply } = await fixture([{ number: 1, labels: ["low"] }]);
  github.beforeRequest = (route) => {
    if (route.startsWith("POST ") && route.endsWith("/comments")) throw new Error("Comment denied");
  };
  await assert.rejects(apply(), /Comment denied/);
  assert.deepEqual(github.issues.get(1).labels, [{ name: "low" }]);
  assert.equal(github.writes().filter((call) => call.route.includes("/labels")).length, 0);
});

test("an interrupted label transition resumes with one reasoning comment", async () => {
  const { github, apply } = await fixture([{ number: 1, labels: ["low"] }]);
  github.beforeRequest = (route) => {
    if (route.startsWith("DELETE ")) throw new Error("Temporary label deletion failure");
  };
  await assert.rejects(apply(), /deletion failure/);
  assert.equal(github.issues.get(1).comments.length, 1);
  assert.match(github.issues.get(1).comments[0].body, /Application:\*\* pending/);
  github.beforeRequest = null;
  await apply();
  assert.equal(github.issues.get(1).comments.length, 1);
  assert.match(github.issues.get(1).comments[0].body, /Application:\*\* completed/);
  assert.deepEqual(github.issues.get(1).labels, [{ name: "high" }]);
  await apply();
  assert.equal(github.issues.get(1).comments.length, 1);
});

test("blocked overrides high and must cite unfinished native prerequisites", async () => {
  const { github, snapshot, plan, apply } = await fixture([{ number: 1 }, { number: 2, blockedBy: [1] }]);
  const invalid = clone(plan);
  invalid.decisions[1].priority = "high";
  assert.throws(() => validatePlan(invalid, snapshot), /blocked must take precedence/);
  invalid.decisions[1].blockers = [];
  assert.throws(() => validatePlan(invalid, snapshot), /omitted an unfinished native prerequisite/);
  await apply();
  assert.deepEqual(github.issues.get(2).labels, [{ name: "blocked" }]);
  assert.ok(github.issues.get(2).comments[0].body.includes(`${REPOSITORY}#1`));
});

test("supports evidence-backed prerequisites even when no native blocking relationship exists", async () => {
  const { github, plan, apply } = await fixture([{ number: 1 }, { number: 2 }]);
  plan.decisions[1].priority = "blocked";
  plan.decisions[1].blockers = [{ issue: `${REPOSITORY}#1`, evidence: EVIDENCE }];
  await apply();
  assert.deepEqual(github.issues.get(2).labels, [{ name: "blocked" }]);
});

test("medium and low are valid independent choices, not fallbacks", async (t) => {
  for (const priority of ["medium", "low"]) {
    await t.test(priority, async () => {
      const { github, plan, apply } = await fixture([{ number: 1, labels: ["high", "bug"] }]);
      plan.decisions[0].priority = priority;
      await apply();
      assert.deepEqual(github.issues.get(1).labels.map((item) => item.name).sort(), ["bug", priority]);
      assert.ok(github.issues.get(1).comments[0].body.includes(`high -> ${priority}`));
    });
  }
});

test("an interrupted audit completion can be finalized after a fresh snapshot in the same run", async () => {
  const first = await fixture([{ number: 1, labels: ["low"] }]);
  first.github.beforeRequest = (route) => {
    if (route.startsWith("PATCH ")) throw new Error("Comment completion failed");
  };
  await assert.rejects(first.apply(), /completion failed/);
  first.github.beforeRequest = null;
  const snapshot = await collectSnapshot({ github: first.github, repository: REPOSITORY, runId: RUN_ID });
  const plan = { ...first.plan, snapshot_id: snapshot.snapshot_id };
  await applyPlan({ github: first.github, snapshot, plan, runUrl: RUN_URL, pause: async () => {} });
  assert.equal(first.github.issues.get(1).comments.length, 1);
  assert.match(first.github.issues.get(1).comments[0].body, /completed \(verified during retry\)/);
  assert.match(first.github.issues.get(1).comments[0].body, /low -> high/);
});

test("late issue edits after the reasoning comment stop label mutations", async () => {
  const { github, apply } = await fixture([{ number: 1, labels: ["low"] }]);
  github.beforeRequest = (route) => {
    if (route.startsWith("POST ") && route.endsWith("/comments")) github.issues.get(1).body = "Edited mid-application";
  };
  await assert.rejects(apply(), /before label reconciliation/);
  assert.deepEqual(github.issues.get(1).labels, [{ name: "low" }]);
  assert.equal(github.issues.get(1).comments.length, 1);
});

test("late prerequisites are detected even when the planned priority is unchanged", async () => {
  const { github, apply } = await fixture([{ number: 1, labels: ["high"] }, { number: 2, labels: ["high"] }]);
  github.beforeRequest = (route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}" && parameters.issue_number === 1) {
      github.issues.get(1).blockedBy = [2];
    }
  };
  await assert.rejects(apply(), /Prerequisites of #1 changed/);
  assert.equal(github.writes().length, 0);
});

test("prerequisites added after reasoning publication stop label mutations", async () => {
  const { github, apply } = await fixture([{ number: 1, labels: ["low"] }, { number: 2 }]);
  github.beforeRequest = (route) => {
    if (route.startsWith("POST ") && route.endsWith("/comments")) github.issues.get(1).blockedBy = [2];
  };
  await assert.rejects(apply(), /Prerequisites of #1 changed/);
  assert.deepEqual(github.issues.get(1).labels, [{ name: "low" }]);
  assert.equal(github.issues.get(1).comments.length, 1);
});

test("oversized reasoning without any groups fails before all mutations", async () => {
  const { github, plan, apply } = await fixture(Array.from({ length: 7 }, (_, index) => ({ number: index + 1 })), []);
  plan.decisions[0].priority = "blocked";
  plan.decisions[0].reason = "x".repeat(10000);
  plan.decisions[0].blockers = Array.from({ length: 6 }, (_, index) => ({
    issue: `${REPOSITORY}#${index + 2}`, evidence: "x".repeat(10000),
  }));
  await assert.rejects(apply(), /Reasoning comment exceeds GitHub's limit/);
  assert.equal(github.writes().length, 0);
});

test("oversized new-parent reasoning fails before creating labels or a parent", async () => {
  const { github, plan, apply } = await fixture(Array.from({ length: 8 }, (_, index) => ({ number: index + 1 })), []);
  plan.groups = [group([1, 2])];
  plan.groups[0].new_parent.priority = "blocked";
  plan.groups[0].new_parent.reason = "x".repeat(10000);
  plan.groups[0].new_parent.blockers = Array.from({ length: 6 }, (_, index) => ({
    issue: `${REPOSITORY}#${index + 3}`, evidence: "x".repeat(10000),
  }));
  await assert.rejects(apply(), /Parent reasoning exceeds GitHub's limit/);
  assert.equal(github.writes().length, 0);
});

test("generated parent metadata and rationale count toward GitHub's body limit", async () => {
  const { github, plan, apply } = await fixture([{ number: 1 }, { number: 2 }], []);
  plan.groups = [group([1, 2])];
  plan.groups[0].new_parent.body = "x".repeat(60000);
  plan.groups[0].reason = "x".repeat(10000);
  await assert.rejects(apply(), /Parent body exceeds GitHub's limit/);
  assert.equal(github.writes().length, 0);
});

test("published parent titles must still fit after mention neutralization", async () => {
  const { github, plan, apply } = await fixture([{ number: 1 }, { number: 2 }], []);
  plan.groups = [group([1, 2])];
  plan.groups[0].new_parent.title = "@".repeat(101);
  await assert.rejects(apply(), /Parent title must contain 5-200 characters/);
  assert.equal(github.writes().length, 0);
});

test("a completed prerequisite is reassessed and removes an outdated blocked label", async () => {
  const { github, apply } = await fixture([
    { number: 1, state: "closed", state_reason: "completed" },
    { number: 2, blockedBy: [1], labels: ["blocked"] },
  ]);
  await apply();
  assert.deepEqual(github.issues.get(2).labels, [{ name: "high" }]);
  assert.match(github.issues.get(2).comments[0].body, /blocked -> high/);
});

test("all open issues beyond one API page receive a decision and a priority", async () => {
  const { github, apply } = await fixture(Array.from({ length: 101 }, (_, index) => ({ number: index + 1 })));
  const result = await apply();
  assert.equal(result.changed.length, 101);
  assert.ok([...github.issues.values()].every((issue) =>
    issue.labels.length === 1 && issue.labels[0].name === "high" && issue.comments.length === 1));
});

test("rejects malformed, incomplete, duplicated, or unauthorized decisions without writes", async (t) => {
  const cases = [
    ["missing issue", (plan) => plan.decisions.pop(), /cover every open issue/],
    ["duplicate issue", (plan) => plan.decisions.push(clone(plan.decisions[0])), /Duplicate decision/],
    ["unknown issue", (plan) => { plan.decisions[0].issue_number = 999; }, /Unknown/],
    ["unknown priority", (plan) => { plan.decisions[0].priority = "urgent"; }, /priority must/],
    ["empty reason", (plan) => { plan.decisions[0].reason = ""; }, /characters/],
    ["invisible reason", (plan) => { plan.decisions[0].reason = "<!-- all reasoning hidden here -->"; }, /characters/],
    ["unknown field", (plan) => { plan.decisions[0].labels = ["bug"]; }, /unknown fields/],
    ["wrong snapshot", (plan) => { plan.snapshot_id = "other"; }, /trusted snapshot/],
    ["no prerequisite", (plan) => { plan.decisions[0].priority = "blocked"; }, /blocked must/],
    ["fabricated prerequisite", (plan) => {
      plan.decisions[0].blockers = [{ issue: `${REPOSITORY}#999`, evidence: EVIDENCE }];
    }, /unknown prerequisite/],
    ["self prerequisite", (plan) => {
      plan.decisions[0].blockers = [{ issue: `${REPOSITORY}#1`, evidence: EVIDENCE }];
    }, /block itself/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const { github, plan, apply } = await fixture();
      mutate(plan);
      await assert.rejects(apply(), expected);
      assert.deepEqual(github.writes(), []);
    });
  }
});

test("the output gate rejects missing, multiple, or invalid JSON tool requests", async () => {
  const { snapshot, plan } = await fixture();
  const item = { type: "apply_issue_triage", plan: JSON.stringify(plan) };
  assert.deepEqual(extractPlan({ items: [item] }, snapshot), plan);
  assert.throws(() => extractPlan({ items: [] }, snapshot), /exactly one/);
  assert.throws(() => extractPlan({ items: [item, item] }, snapshot), /exactly one/);
  assert.throws(() => extractPlan({ items: [item, { type: "report_incomplete" }] }, snapshot), /other action or failure/);
  assert.throws(() => extractPlan({ items: [{ ...item, plan: "not JSON" }] }, snapshot), SyntaxError);
  assert.throws(() => extractPlan({ items: [{ ...item, plan }] }, snapshot), /JSON string/);
});

test("framework staged mode comes from independently generated, run-bound metadata", async () => {
  const { snapshot } = await fixture();
  const info = { repository: REPOSITORY, run_id: Number(RUN_ID), staged: true };
  assert.equal(isStagedRun(info, snapshot), true);
  assert.equal(isStagedRun({ ...info, staged: false }, snapshot), false);
  for (const invalid of [null, [], {}, { ...info, repository: "other/repository" },
    { ...info, run_id: 124 }, { ...info, staged: "false" }, { ...info, staged: undefined }]) {
    assert.throws(() => isStagedRun(invalid, snapshot), /Invalid trusted workflow metadata/);
  }
});

test("stale issue, prerequisite, parent, open-set, and repository changes fail before writes", async (t) => {
  const cases = [
    ["body", (github) => { github.issues.get(1).body = "Changed requirements"; }],
    ["priority", (github) => { github.issues.get(1).labels = [{ name: "low" }]; }],
    ["comment", (github) => { github.issues.get(1).comments.push({ id: 8, body: EVIDENCE, user: { login: "maintainer" } }); }],
    ["new issue", (github) => { github.add({ number: 3 }); }],
    ["closed issue", (github) => { github.issues.get(2).state = "closed"; }],
    ["parent", (github) => { github.issues.get(1).parent = 2; }],
    ["prerequisite", (github) => { github.issues.get(1).blockedBy = [2]; }],
    ["commit", (github) => { github.sourceSha = "b".repeat(40); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const { github, apply } = await fixture([{ number: 1 }, { number: 2 }]);
      mutate(github);
      await assert.rejects(apply(), /changed during analysis/);
      assert.deepEqual(github.writes(), []);
    });
  }
});

test("creates a native parent, priorities it, and never copies/replaces children", async () => {
  const { github, plan, apply } = await fixture([{ number: 1 }, { number: 2 }]);
  plan.groups = [group([1, 2])];
  const result = await apply();
  assert.equal(github.issues.size, 3);
  assert.equal(result.groups[0].parent, 3);
  assert.deepEqual(github.issues.get(3).labels, [{ name: "high" }]);
  assert.equal(github.issues.get(3).comments.length, 1);
  assert.equal(github.issues.get(1).parent, 3);
  assert.equal(github.issues.get(2).parent, 3);
  const links = github.writes().filter((call) => call.route.endsWith("/sub_issues"));
  assert.deepEqual(links.map((call) => call.parameters.sub_issue_id), [10001, 10002]);
  assert.ok(github.issues.get(3).body.includes("<!-- issue-priority-triage-group: foundation -->"));
});

test("a second complete run reuses a generated parent with expanded membership without comment spam", async () => {
  const first = await fixture([{ number: 1 }, { number: 2 }]);
  first.plan.groups = [group([1, 2])];
  await first.apply();
  first.github.add({ number: 4 });
  const snapshot = await collectSnapshot({ github: first.github, repository: REPOSITORY, runId: "124" });
  const plan = {
    version: 1, snapshot_id: snapshot.snapshot_id,
    decisions: snapshot.issues.map((issue) => ({ issue_number: issue.number, priority: "high", reason: REASON, blockers: [] })),
    groups: [group([1, 2, 4])],
  };
  const output = { items: [{ type: "apply_issue_triage", plan: JSON.stringify(plan) }] };
  const result = await applyPlan({
    github: first.github, snapshot, plan: extractPlan(output, snapshot),
    runUrl: RUN_URL.replace("123", "124"), pause: async () => {},
  });
  assert.equal(first.github.issues.size, 4);
  assert.equal(result.groups[0].parent, 3);
  assert.equal(first.github.issues.get(4).parent, 3);
  assert.equal(first.github.issues.get(1).comments.length, 1);
  assert.equal(first.github.issues.get(3).comments.length, 1);
});

test("an interrupted parent creation/linking run resumes instead of duplicating the group", async () => {
  const { github, plan, apply } = await fixture([{ number: 1 }, { number: 2 }]);
  plan.groups = [group([1, 2])];
  github.beforeRequest = (route, parameters) => {
    if (route.startsWith("POST ") && route.endsWith("/sub_issues") && parameters.sub_issue_id === 10002) {
      throw new Error("Temporary sub-issue failure");
    }
  };
  await assert.rejects(apply(), /sub-issue failure/);
  github.beforeRequest = null;
  await apply();
  assert.equal(github.issues.size, 3);
  assert.equal(github.issues.get(2).parent, 3);
  assert.equal(github.issues.get(3).comments.length, 1);
  assert.equal(github.issues.get(1).comments.length, 1);
});

test("reuses human-created parents without changing their body, title, or existing relationships", async () => {
  const { github, plan, apply } = await fixture([
    { number: 1, parent: 3 }, { number: 2 }, { number: 3, title: "Human parent", body: REASON },
  ]);
  plan.groups = [group([1, 2], 3)];
  await apply();
  assert.equal(github.issues.size, 3);
  assert.equal(github.issues.get(3).title, "Human parent");
  assert.equal(github.issues.get(3).body, REASON);
  assert.equal(github.issues.get(1).parent, 3);
  assert.equal(github.writes().filter((call) => call.route.endsWith("/sub_issues")).length, 1);
});

test("rejects conflicting parents, duplicate groups, self-links, and regrouping parents", async (t) => {
  for (const [name, proposed] of [
    ["conflicting parent", [group([1, 2])]],
    ["duplicate membership", [group([1, 2], 3), group([1, 2], 3, "other")]],
    ["self link", [group([1, 3], 3)]],
    ["parent as child", [group([2, 3])]],
    ["one member", [group([2])]],
  ]) {
    await t.test(name, async () => {
      const { github, plan, apply } = await fixture([{ number: 1, parent: 3 }, { number: 2 }, { number: 3 }]);
      plan.groups = proposed;
      await assert.rejects(apply());
      assert.deepEqual(github.writes(), []);
    });
  }
});

test("rejects a proposed 101-child group before any mutations", async () => {
  const { github, plan, apply } = await fixture(Array.from({ length: 101 }, (_, index) => ({ number: index + 1 })));
  plan.groups = [group(Array.from({ length: 101 }, (_, index) => index + 1))];
  await assert.rejects(apply(), /exceeds 100/);
  assert.deepEqual(github.writes(), []);
});

test("rejects adding children beneath a parent already at the eighth hierarchy level", async () => {
  const records = Array.from({ length: 8 }, (_, index) => ({
    number: index + 1, parent: index === 0 ? null : index,
  }));
  records.push({ number: 9 }, { number: 10 });
  const { github, plan, apply } = await fixture(records);
  plan.groups = [group([9, 10], 8)];
  await assert.rejects(apply(), /eight nesting levels/);
  assert.deepEqual(github.writes(), []);
});

test("parent membership alone does not make issues blocked", async () => {
  const { github, apply } = await fixture([{ number: 1, parent: 2 }, { number: 2 }]);
  await apply();
  assert.deepEqual(github.issues.get(1).labels, [{ name: "high" }]);
  assert.deepEqual(github.issues.get(2).labels, [{ name: "high" }]);
});

test("preview and framework staged mode make no mutations, even with missing labels/new groups", async (t) => {
  for (const flags of [{ dryRun: true }, { staged: true }]) {
    await t.test(JSON.stringify(flags), async () => {
      const { github, plan, apply } = await fixture([{ number: 1 }, { number: 2 }], []);
      plan.groups = [group([1, 2])];
      const result = await apply(flags);
      assert.equal(result.preview, true);
      assert.deepEqual(result.created_labels, PRIORITIES);
      assert.equal(result.groups[0].parent, "new");
      assert.ok(summary(result).includes("no changes made"));
      assert.deepEqual(github.writes(), []);
    });
  }
});

test("an empty backlog has no mutation or AI request", async () => {
  const { github, snapshot, plan, apply } = await fixture([]);
  assert.equal(extractPlan({ items: [] }, snapshot), null);
  const result = await apply();
  assert.equal(result.changed.length, 0);
  assert.deepEqual(github.writes(), []);
  assert.throws(() => extractPlan({ items: [{ type: "apply_issue_triage", plan: JSON.stringify(plan) }] }, snapshot),
    /Empty backlogs/);
});

test("neutralizes model-provided metadata and mentions on published issues/comments", async () => {
  const { github, plan, apply } = await fixture([{ number: 1 }, { number: 2 }]);
  plan.decisions[0].reason += " @someone <!-- forged -->";
  plan.groups = [group([1, 2])];
  plan.groups[0].new_parent.body += " @team <!-- forged -->";
  await apply();
  assert.ok(!github.issues.get(1).comments[0].body.includes("@someone"));
  assert.ok(!github.issues.get(1).comments[0].body.includes("<!-- forged -->"));
  assert.ok(!github.issues.get(3).body.includes("@team"));
  assert.ok(!github.issues.get(3).body.includes("<!-- forged -->"));
});

test("compiled workflow keeps inference read-only and gates writes on successful analysis/detection", () => {
  const workflow = readFileSync(join(__dirname, "../workflows/issue-priority-triage.lock.yml"), "utf8");
  const agent = workflow.split("\n  agent:\n")[1].split("\n  apply_issue_triage:\n")[0];
  const apply = workflow.split("\n  apply_issue_triage:\n")[1].split("\n  conclusion:\n")[0];
  assert.ok(agent.includes("copilot-requests: write"));
  assert.ok(!agent.includes("issues: write"));
  assert.ok(!agent.includes("contents: write"));
  assert.ok(agent.includes("COPILOT_GITHUB_TOKEN: ${{ github.token }}"));
  assert.ok(agent.includes("--deny-tool=write"));
  assert.ok(agent.includes("--deny-tool=shell"));
  assert.ok(agent.includes('fs.readFileSync("/tmp/gh-aw/agent_output.json"'));
  assert.ok(apply.includes("needs.agent.result == 'success'"));
  assert.ok(apply.includes("needs.detection.outputs.detection_success == 'true'"));
  assert.ok(apply.includes("TRIAGE_DRY_RUN: ${{ inputs.dry_run }}"));
  assert.ok(apply.includes("name: info"));
  assert.ok(apply.includes("staged: isStagedRun(info, snapshot)"));
  assert.ok(apply.includes("issues: write"));
  assert.ok(!workflow.includes("secrets.COPILOT_GITHUB_TOKEN"));
  assert.ok(!workflow.includes("\n  schedule:"));
  assert.ok(workflow.includes("queue: max"));
  assert.ok(workflow.includes('GH_AW_DETECTION_CONTINUE_ON_ERROR: "false"'));
  assert.ok(!workflow.includes('GH_AW_MISSING_TOOL_CREATE_ISSUE: "true"'));
  assert.ok(!workflow.includes('GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE: "true"'));
  assert.ok(!workflow.includes('\\"create_report_incomplete_issue\\"'));
});
