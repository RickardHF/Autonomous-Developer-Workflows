const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const PRIORITIES = ["high", "medium", "low", "blocked"];
const API_VERSION = "2026-03-10";
const WORKFLOW_ID = "issue-priority-triage";
const GROUP_PATTERN = /<!-- issue-priority-triage-group: ([a-z0-9][a-z0-9-]{0,79}) -->/;
const MEMBERS_PATTERN = /<!-- issue-priority-triage-members: ([\d,]+) -->/;
const RUN_PATTERN = /<!-- issue-priority-triage-run: (\d+) -->/;
const BOT = "github-actions[bot]";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function object(value, fields, location) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${location} must be an object`);
  check(Object.keys(value).every((key) => fields.includes(key)), `${location} contains unknown fields`);
  check(fields.every((key) => Object.hasOwn(value, key)), `${location} is missing required fields`);
}

function text(value, location, min = 20, max = 10000) {
  const visible = typeof value === "string" ? sanitize(value) : "";
  check(typeof value === "string" && visible.length >= min && visible.length <= max && value.length <= max,
    `${location} must contain ${min}-${max} characters`);
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), `${location} contains control characters`);
}

function number(value, location) {
  check(Number.isSafeInteger(value) && value > 0, `${location} must be a positive issue number`);
}

function unique(values, location) {
  check(new Set(values).size === values.length, `${location} contains duplicates`);
}

function managed(labels) {
  return labels.filter((name) => PRIORITIES.includes(name)).sort();
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function api(github, repository, pause = () => delay(1000)) {
  check(/^[^/]+\/[^/]+$/.test(repository), "Invalid repository");
  const [owner, repo] = repository.split("/");
  const parameters = (extra) => ({ owner, repo, headers: { "X-GitHub-Api-Version": API_VERSION }, ...extra });
  return {
    async get(path, extra = {}) {
      return (await github.request(`GET /repos/{owner}/{repo}${path}`, parameters(extra))).data;
    },
    async list(path, extra = {}) {
      return github.paginate(`GET /repos/{owner}/{repo}${path}`, parameters({ per_page: 100, ...extra }));
    },
    async write(method, path, extra = {}) {
      const result = await github.request(`${method} /repos/{owner}/{repo}${path}`, parameters(extra));
      await pause();
      return result.data;
    },
  };
}

function reference(issue, repository) {
  const match = issue.repository_url?.match(/\/repos\/([^/]+\/[^/]+)$/);
  return `${match ? match[1] : repository}#${issue.number}`;
}

function compact(issue, repository) {
  number(issue.number, "GitHub issue");
  check(Number.isSafeInteger(issue.id) && issue.id > 0, `Missing database ID for #${issue.number}`);
  check(issue.state === "open" || issue.state === "closed", `Invalid state for #${issue.number}`);
  return {
    reference: reference(issue, repository),
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    state_reason: issue.state_reason ?? null,
    updated_at: issue.updated_at,
    author: issue.user?.login,
  };
}

function generatedGroup(issue) {
  if (issue.author !== BOT) return null;
  const match = issue.body.match(GROUP_PATTERN);
  if (!match || !issue.body.includes(`<!-- gh-aw-workflow-id: ${WORKFLOW_ID} -->`)) return null;
  return {
    key: match[1],
    members: (issue.body.match(MEMBERS_PATTERN)?.[1] ?? "").split(",").filter(Boolean).map(Number),
    run_id: issue.body.match(RUN_PATTERN)?.[1] ?? null,
  };
}

async function parentOf(client, issue) {
  if (issue.parent_issue_url === null) return null;
  try {
    return await client.get("/issues/{issue_number}/parent", { issue_number: issue.number });
  } catch (error) {
    if (error.status !== 404 || issue.parent_issue_url) throw error;
    return null;
  }
}

async function collectSnapshot({ github, repository, runId }) {
  check(/^\d+$/.test(String(runId)), "Invalid workflow run ID");
  const client = api(github, repository);
  const metadata = await client.get("");
  const commit = await client.get("/commits/{ref}", { ref: metadata.default_branch });
  const all = (await client.list("/issues", { state: "all", sort: "created", direction: "asc" }))
    .filter((issue) => !issue.pull_request);
  const issues = [];
  for (const raw of all.filter((issue) => issue.state === "open")) {
    const comments = await client.list("/issues/{issue_number}/comments", { issue_number: raw.number });
    const children = raw.sub_issues_summary?.total === 0 ? [] :
      await client.list("/issues/{issue_number}/sub_issues", { issue_number: raw.number });
    const blockers = raw.issue_dependencies_summary?.blocked_by === 0 ? [] :
      await client.list("/issues/{issue_number}/dependencies/blocked_by", { issue_number: raw.number });
    const ancestors = [];
    let parent = await parentOf(client, raw);
    while (parent) {
      check(!ancestors.some((item) => item.reference === reference(parent, repository)), "Existing parent cycle");
      ancestors.push(compact(parent, repository));
      check(ancestors.length < 8, `Existing hierarchy exceeds GitHub's eight levels at #${raw.number}`);
      if (reference(parent, repository).split("#")[0] !== repository) break;
      parent = await parentOf(client, parent);
    }
    issues.push({
      ...compact(raw, repository),
      labels: raw.labels.map((label) => typeof label === "string" ? label : label.name).sort(),
      comments: comments.map((comment) => ({
        id: comment.id, body: comment.body ?? "", author: comment.user?.login, updated_at: comment.updated_at,
      })).sort((a, b) => a.id - b.id),
      ancestors,
      children: children.map((child) => compact(child, repository)).sort((a, b) => a.reference.localeCompare(b.reference)),
      blocked_by: blockers.map((blocker) => compact(blocker, repository)).sort((a, b) => a.reference.localeCompare(b.reference)),
    });
  }
  const snapshot = {
    version: 1,
    repository,
    run_id: String(runId),
    default_branch: metadata.default_branch,
    source_sha: commit.sha,
    issues: issues.sort((a, b) => a.number - b.number),
    closed_issues: all.filter((issue) => issue.state === "closed").map((issue) => compact(issue, repository))
      .sort((a, b) => a.number - b.number),
  };
  snapshot.snapshot_id = hash(snapshot);
  return snapshot;
}

function knownIssues(snapshot) {
  const known = new Map([...snapshot.issues, ...snapshot.closed_issues].map((issue) => [issue.reference, issue]));
  for (const issue of snapshot.issues) {
    for (const blocker of issue.blocked_by) known.set(blocker.reference, blocker);
  }
  return known;
}

function validateDecision(decision, known, nativeBlockers, location, self) {
  check(PRIORITIES.includes(decision.priority), `${location}: priority must be high, medium, low, or blocked`);
  text(decision.reason, `${location}.reason`);
  check(Array.isArray(decision.blockers), `${location}.blockers must be an array`);
  const references = [];
  for (const blocker of decision.blockers) {
    object(blocker, ["issue", "evidence"], `${location}.blocker`);
    text(blocker.evidence, `${location}.blocker.evidence`);
    check(typeof blocker.issue === "string" && known.has(blocker.issue), `${location}: unknown prerequisite ${blocker.issue}`);
    check(blocker.issue !== self, `${location}: an issue cannot block itself`);
    check(known.get(blocker.issue).state === "open", `${location}: prerequisite ${blocker.issue} is no longer open`);
    references.push(blocker.issue);
  }
  unique(references, `${location}.blockers`);
  const unfinished = nativeBlockers.filter((issue) => issue.state === "open");
  check(unfinished.every((issue) => references.includes(issue.reference)), `${location}: omitted an unfinished native prerequisite`);
  check((decision.priority === "blocked") === (references.length > 0),
    `${location}: blocked must take precedence exactly when unfinished prerequisites are identified`);
}

function validatePlan(plan, snapshot) {
  object(plan, ["version", "snapshot_id", "decisions", "groups"], "Plan");
  check(plan.version === 1 && plan.snapshot_id === snapshot.snapshot_id, "Plan does not match the trusted snapshot");
  check(Array.isArray(plan.decisions) && Array.isArray(plan.groups), "Decisions and groups must be arrays");
  const issues = new Map(snapshot.issues.map((issue) => [issue.number, issue]));
  const known = knownIssues(snapshot);
  const decisions = new Map();
  for (const decision of plan.decisions) {
    object(decision, ["issue_number", "priority", "reason", "blockers"], "Decision");
    number(decision.issue_number, "Decision.issue_number");
    check(issues.has(decision.issue_number), `Unknown/open-issue target #${decision.issue_number}`);
    check(!decisions.has(decision.issue_number), `Duplicate decision for #${decision.issue_number}`);
    const issue = issues.get(decision.issue_number);
    validateDecision(decision, known, issue.blocked_by, `#${issue.number}`, issue.reference);
    decisions.set(issue.number, decision);
  }
  check(decisions.size === issues.size, "Plan must cover every open issue exactly once");
  const usedChildren = new Set();
  const usedParents = new Set();
  const keys = new Set();
  const groups = [];
  for (const group of plan.groups) {
    object(group, ["key", "parent_issue_number", "children", "reason", "new_parent"], "Group");
    check(typeof group.key === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(group.key), "Invalid stable group key");
    check(!keys.has(group.key), `Duplicate group key ${group.key}`);
    keys.add(group.key);
    text(group.reason, `Group ${group.key}.reason`);
    check(Array.isArray(group.children) && group.children.length >= 2, "Groups must contain at least two issues");
    group.children.forEach((child) => number(child, "Group child"));
    unique(group.children, "Group children");
    let parent = group.parent_issue_number;
    if (parent !== null) {
      number(parent, "Group parent");
      check(issues.has(parent), `Group parent #${parent} is not an open issue in this repository`);
      check(group.new_parent === null, "Existing parents must not include replacement content");
    } else {
      object(group.new_parent, ["title", "body", "priority", "reason", "blockers"], "New parent");
      text(group.new_parent.title, "Parent title", 5, 200);
      text(group.new_parent.body, "Parent body", 20, 60000);
      validateDecision(group.new_parent, known, [], `Group ${group.key} priority`);
      const candidates = [...snapshot.issues, ...snapshot.closed_issues].filter((issue) => {
        const marker = generatedGroup(issue);
        return marker && (marker.key === group.key || marker.members.some((child) => group.children.includes(child)) ||
          issue.children?.some((child) => group.children.includes(child.number)));
      });
      check(candidates.length <= 1, `Group ${group.key} overlaps multiple existing groups; explicitly reuse a parent`);
      if (candidates.length === 1) {
        check(candidates[0].state === "open", `Group ${group.key} matches closed parent #${candidates[0].number}; do not reopen or duplicate it`);
        parent = candidates[0].number;
      }
    }
    if (parent !== null) {
      check(!usedParents.has(parent), `Duplicate proposals for parent #${parent}`);
      usedParents.add(parent);
      check(issues.get(parent).ancestors.length + 2 <= 8, `Parent #${parent} would exceed eight nesting levels`);
    }
    const existingChildren = parent === null ? [] : issues.get(parent).children.map((child) => child.reference);
    for (const child of group.children) {
      check(issues.has(child), `Unknown group child #${child}`);
      const issue = issues.get(child);
      check(child !== parent, "A parent cannot be its own sub-issue");
      check(!usedChildren.has(child), `Issue #${child} appears in multiple groups`);
      usedChildren.add(child);
      check(!generatedGroup(issue) && issue.children.length === 0, `Do not regroup parent issue #${child}`);
      check(issue.ancestors.length === 0 || issue.ancestors[0].reference === `${snapshot.repository}#${parent}`,
        `Preserve #${child}'s existing parent`);
    }
    check(new Set([...existingChildren, ...group.children.map((child) => `${snapshot.repository}#${child}`)]).size <= 100,
      `Group ${group.key} exceeds 100 sub-issues`);
    groups.push({ ...group, parent_issue_number: parent });
  }
  check([...usedParents].every((parent) => !usedChildren.has(parent)), "Group proposals contain a parent/child cycle");
  return { ...plan, groups };
}

function extractPlan(output, snapshot) {
  check(output !== null && typeof output === "object" && Array.isArray(output.items), "Missing structured agent output");
  const requests = output.items.filter((item) => item.type === "apply_issue_triage");
  if (snapshot.issues.length === 0) {
    check(requests.length === 0, "Empty backlogs must not request mutations");
    return null;
  }
  check(requests.length === 1, "Agent must submit exactly one complete apply_issue_triage request");
  check(output.items.length === 1, "A complete triage plan must not include other action or failure requests");
  const request = requests[0];
  check(typeof request.plan === "string", "The plan input must be a JSON string");
  const plan = JSON.parse(request.plan);
  validatePlan(plan, snapshot);
  return plan;
}

function isStagedRun(info, snapshot) {
  check(info !== null && typeof info === "object" && !Array.isArray(info) &&
    info.repository === snapshot.repository && String(info.run_id) === snapshot.run_id &&
    typeof info.staged === "boolean", "Invalid trusted workflow metadata for this repository/run");
  return info.staged;
}

function sanitize(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "").replace(/@/g, "@\u200b").trim();
}

function footer(runUrl) {
  return `\n\nGenerated by [AI issue priority triage](${runUrl}).\n<!-- gh-aw-workflow-id: ${WORKFLOW_ID} -->`;
}

function transitionMarker(snapshot, issue, decision) {
  return `<!-- issue-priority-triage-transition: ${snapshot.run_id}:${issue.number}:${hash({
    before: managed(issue.labels), priority: decision.priority,
  })} -->`;
}

function auditComment(issue, marker) {
  return issue.comments.find((comment) => comment.author === BOT && comment.body.includes(marker));
}

function stableIssue(issue, runId) {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.filter((label) => !PRIORITIES.includes(label)),
    comments: issue.comments.filter((comment) =>
      !(comment.author === BOT && comment.body.includes(`<!-- issue-priority-triage-transition: ${runId}:`))),
    blocked_by: stableBlockers(issue.blocked_by),
  };
}

function stableBlockers(blockers) {
  return blockers.map((blocker) => ({
    reference: blocker.reference, id: blocker.id, title: blocker.title, body: blocker.body, state: blocker.state,
  })).sort((a, b) => a.reference.localeCompare(b.reference));
}

async function assertCurrentBlockers(client, repository, issue, raw) {
  const blockers = raw.issue_dependencies_summary?.blocked_by === 0 ? [] :
    await client.list("/issues/{issue_number}/dependencies/blocked_by", { issue_number: issue.number });
  check(same(stableBlockers(issue.blocked_by), stableBlockers(blockers.map((blocker) => compact(blocker, repository)))),
    `Prerequisites of #${issue.number} changed before its update`);
}

function assertFresh(snapshot, live, plan) {
  check(live.repository === snapshot.repository && live.source_sha === snapshot.source_sha,
    "Repository revision changed during analysis; run triage again");
  check(same(snapshot.closed_issues, live.closed_issues), "Closed issue context changed during analysis; run triage again");
  const initial = new Map(snapshot.issues.map((issue) => [issue.number, issue]));
  const current = new Map(live.issues.map((issue) => [issue.number, issue]));
  const resumedParents = new Map();
  for (const issue of live.issues.filter((item) => !initial.has(item.number))) {
    const marker = generatedGroup(issue);
    const group = plan.groups.find((item) => item.parent_issue_number === null && marker?.key === item.key);
    check(marker?.run_id === snapshot.run_id && group && same(marker.members, [...group.children].sort((a, b) => a - b)),
      "Open issue set changed during analysis; run triage again");
    resumedParents.set(group.key, issue.number);
  }
  for (const issue of snapshot.issues) {
    const latest = current.get(issue.number);
    check(latest && same(stableIssue(issue, snapshot.run_id), stableIssue(latest, snapshot.run_id)),
      `Issue #${issue.number} changed during analysis; run triage again`);
    const decision = plan.decisions.find((item) => item.issue_number === issue.number);
    const before = managed(issue.labels);
    const after = managed(latest.labels);
    const ownTransition = auditComment(latest, transitionMarker(snapshot, issue, decision));
    check(same(before, after) || (ownTransition && after.includes(decision.priority) &&
      after.every((label) => before.includes(label) || label === decision.priority)),
    `Priority of #${issue.number} changed during analysis; run triage again`);
    const childGroup = plan.groups.find((group) => group.children.includes(issue.number));
    const allowedParent = childGroup && (childGroup.parent_issue_number ?? resumedParents.get(childGroup.key));
    const ancestors = (items) => items.map((ancestor) => ({ reference: ancestor.reference, id: ancestor.id, state: ancestor.state }));
    check(same(ancestors(issue.ancestors), ancestors(latest.ancestors)) || (issue.ancestors.length === 0 && allowedParent &&
      latest.ancestors[0]?.reference === `${snapshot.repository}#${allowedParent}`),
    `Parent of #${issue.number} changed during analysis; run triage again`);
    const group = plan.groups.find((item) => item.parent_issue_number === issue.number);
    const beforeChildren = issue.children.map((item) => item.reference);
    const afterChildren = latest.children.map((item) => item.reference);
    const approvedChildren = group?.children.map((child) => `${snapshot.repository}#${child}`) ?? [];
    check(beforeChildren.every((child) => afterChildren.includes(child)) &&
      afterChildren.every((child) => beforeChildren.includes(child) || approvedChildren.includes(child)),
    `Sub-issues of #${issue.number} changed during analysis; run triage again`);
  }
  return resumedParents;
}

function reasoningBody(snapshot, issue, decision, marker, runUrl, status) {
  const blockers = decision.blockers.length === 0 ? "" :
    `\n\n**Unfinished prerequisites:**\n${decision.blockers.map((blocker) =>
      `- ${blocker.issue}: ${sanitize(blocker.evidence)}`).join("\n")}`;
  return `### Priority decision\n\n**${managed(issue.labels).join(", ") || "unassigned"} -> ${decision.priority}**\n\n` +
    `${sanitize(decision.reason)}${blockers}\n\n**Repository revision:** \`${snapshot.source_sha}\`\n\n` +
    `**Application:** ${status}${footer(runUrl)}\n${marker}`;
}

async function applyPriority({ client, snapshot, issue, decision, runUrl, result, onProgress }) {
  const raw = await client.get("/issues/{issue_number}", { issue_number: issue.number });
  check(raw.state === "open" && raw.id === issue.id && raw.title === issue.title && (raw.body ?? "") === issue.body,
    `Issue #${issue.number} changed before its update`);
  const labels = raw.labels.map((label) => typeof label === "string" ? label : label.name);
  const marker = transitionMarker(snapshot, issue, decision);
  const comments = await client.list("/issues/{issue_number}/comments", { issue_number: issue.number });
  const currentComments = comments.map((item) => ({
    id: item.id, body: item.body ?? "", author: item.user?.login, updated_at: item.updated_at,
  })).sort((a, b) => a.id - b.id);
  check(same(stableIssue(issue, snapshot.run_id).comments,
    stableIssue({ ...issue, comments: currentComments }, snapshot.run_id).comments),
  `Comments on #${issue.number} changed before its update`);
  let comment = auditComment({ comments: currentComments }, marker);
  const current = managed(labels);
  const before = managed(issue.labels);
  check(same(before, current) || (comment && current.includes(decision.priority) &&
    current.every((label) => before.includes(label) || label === decision.priority)),
  `Priority of #${issue.number} changed before its update`);
  await assertCurrentBlockers(client, snapshot.repository, issue, raw);
  if (same(current, [decision.priority])) {
    if (!comment) {
      comment = currentComments.find((item) => item.author === BOT &&
        item.body.includes(`<!-- issue-priority-triage-transition: ${snapshot.run_id}:${issue.number}:`) &&
        item.body.includes(`-> ${decision.priority}**`) && item.body.includes("**Application:** pending"));
      if (comment) {
        await client.write("PATCH", "/issues/comments/{comment_id}", {
          comment_id: comment.id,
          body: comment.body.replace(/\*\*Application:\*\* pending[^\n]*/, "**Application:** completed (verified during retry)"),
        });
      }
      result.unchanged.push(issue.number);
      return;
    }
    if (comment && !comment.body.includes("**Application:** completed")) {
      await client.write("PATCH", "/issues/comments/{comment_id}", {
        comment_id: comment.id,
        body: reasoningBody(snapshot, issue, decision, marker, runUrl, "completed"),
      });
    }
    result.unchanged.push(issue.number);
    return;
  }
  if (!comment) {
    comment = await client.write("POST", "/issues/{issue_number}/comments", {
      issue_number: issue.number,
      body: reasoningBody(snapshot, issue, decision, marker, runUrl, "pending; labels have not yet been reconciled"),
    });
    await onProgress({ issue: issue.number, operation: "reasoning-comment", comment_id: comment.id });
  }
  const beforeLabels = await client.get("/issues/{issue_number}", { issue_number: issue.number });
  check(beforeLabels.state === "open" && beforeLabels.title === issue.title && (beforeLabels.body ?? "") === issue.body &&
    same(managed(beforeLabels.labels.map((label) => label.name)), current),
  `Issue #${issue.number} changed before label reconciliation; reasoning is recorded but application is incomplete`);
  await assertCurrentBlockers(client, snapshot.repository, issue, beforeLabels);
  if (!labels.includes(decision.priority)) {
    await client.write("POST", "/issues/{issue_number}/labels", { issue_number: issue.number, labels: [decision.priority] });
    await onProgress({ issue: issue.number, operation: "add-priority", priority: decision.priority });
  }
  for (const label of current.filter((name) => name !== decision.priority)) {
    await client.write("DELETE", "/issues/{issue_number}/labels/{name}", { issue_number: issue.number, name: label });
    await onProgress({ issue: issue.number, operation: "remove-priority", priority: label });
  }
  const updated = await client.get("/issues/{issue_number}", { issue_number: issue.number });
  check(updated.state === "open" && same(managed(updated.labels.map((label) => label.name)), [decision.priority]),
    `Failed to verify exactly one priority on #${issue.number}; application is incomplete`);
  await client.write("PATCH", "/issues/comments/{comment_id}", {
    comment_id: comment.id, body: reasoningBody(snapshot, issue, decision, marker, runUrl, "completed"),
  });
  result.changed.push(issue.number);
}

function groupBody(group, snapshot, runUrl) {
  return `${sanitize(group.new_parent.body)}\n\n### Why this work belongs together\n\n${sanitize(group.reason)}\n\n` +
    `### Initial sub-issues\n\n${group.children.map((child) => `- #${child}`).join("\n")}\n\n` +
    `The native sub-issue list tracks current membership and progress.${footer(runUrl)}\n` +
    `<!-- issue-priority-triage-group: ${group.key} -->\n` +
    `<!-- issue-priority-triage-members: ${[...group.children].sort((a, b) => a - b).join(",")} -->\n` +
    `<!-- issue-priority-triage-run: ${snapshot.run_id} -->`;
}

async function applyPlan({
  github, snapshot, plan, runUrl, dryRun = false, staged = false,
  pause, onProgress = async () => {},
}) {
  check(typeof dryRun === "boolean" && typeof staged === "boolean", "Preview flags must be booleans");
  check(typeof runUrl === "string" && /^https:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(runUrl), "Invalid workflow run URL");
  const validated = validatePlan(plan, snapshot);
  const client = api(github, snapshot.repository, pause);
  const live = await collectSnapshot({ github, repository: snapshot.repository, runId: snapshot.run_id });
  const resumedParents = assertFresh(snapshot, live, validated);
  const result = {
    preview: dryRun || staged,
    decisions: [...validated.decisions],
    changed: [], unchanged: [], groups: [], created_labels: [],
  };
  if (snapshot.issues.length === 0) return result;
  const labels = await client.list("/labels");
  for (const priority of PRIORITIES) {
    check(!labels.some((label) => label.name !== priority && label.name.toLowerCase() === priority),
      `Label spelling conflicts with "${priority}"; use the exact lowercase name before running triage`);
  }
  for (const group of validated.groups) {
    if (group.parent_issue_number === null) {
      check(groupBody(group, snapshot, runUrl).length <= 65536, `Parent body exceeds GitHub's limit for ${group.key}`);
      const issue = { number: Number.MAX_SAFE_INTEGER, labels: [] };
      check(reasoningBody(snapshot, issue, group.new_parent, transitionMarker(snapshot, issue, group.new_parent),
        runUrl, "pending; labels have not yet been reconciled").length <= 65536,
      `Parent reasoning exceeds GitHub's limit for ${group.key}`);
    }
  }
  for (const decision of validated.decisions) {
    const issue = snapshot.issues.find((item) => item.number === decision.issue_number);
    check(reasoningBody(snapshot, issue, decision, transitionMarker(snapshot, issue, decision), runUrl,
      "pending; labels have not yet been reconciled").length <= 65536,
    `Reasoning comment exceeds GitHub's limit for #${issue.number}`);
  }
  if (result.preview) {
    result.changed = snapshot.issues.filter((issue) =>
      !same(managed(issue.labels), [validated.decisions.find((decision) => decision.issue_number === issue.number).priority]))
      .map((issue) => issue.number);
    result.unchanged = snapshot.issues.filter((issue) => !result.changed.includes(issue.number)).map((issue) => issue.number);
    result.groups = validated.groups.map((group) => ({
      key: group.key, parent: group.parent_issue_number ?? resumedParents.get(group.key) ?? "new",
      children: group.children,
      new_parent: group.parent_issue_number === null && !resumedParents.has(group.key) ? group.new_parent : null,
      reason: group.reason,
    }));
    result.created_labels = PRIORITIES.filter((priority) => !labels.some((label) => label.name === priority));
    return result;
  }
  const colors = { high: "D73A4A", medium: "FBCA04", low: "0E8A16", blocked: "5319E7" };
  const descriptions = {
    high: "Urgent work or the most useful actionable next step",
    medium: "Useful planned work, not the next highest priority",
    low: "Optional work with little current payoff",
    blocked: "Waiting for unfinished prerequisite tasks",
  };
  for (const priority of PRIORITIES.filter((item) => !labels.some((label) => label.name === item))) {
    await client.write("POST", "/labels", { name: priority, color: colors[priority], description: descriptions[priority] });
    result.created_labels.push(priority);
    await onProgress({ operation: "create-label", priority });
  }
  const targets = new Map(snapshot.issues.map((issue) => [issue.number, issue]));
  const expectedPriorities = new Map(validated.decisions.map((decision) => [decision.issue_number, decision.priority]));
  for (const decision of validated.decisions) {
    await applyPriority({ client, snapshot, issue: targets.get(decision.issue_number), decision, runUrl, result, onProgress });
  }
  for (const group of validated.groups) {
    let parent = group.parent_issue_number ?? resumedParents.get(group.key);
    if (!parent) {
      const created = await client.write("POST", "/issues", {
        title: sanitize(group.new_parent.title), body: groupBody(group, snapshot, runUrl),
      });
      const issue = { ...compact(created, snapshot.repository), labels: [], comments: [], children: [], blocked_by: [], ancestors: [] };
      parent = issue.number;
      targets.set(parent, issue);
      await onProgress({ operation: "create-parent", key: group.key, parent });
    } else if (!targets.has(parent)) {
      targets.set(parent, live.issues.find((issue) => issue.number === parent));
    }
    if (group.parent_issue_number === null) {
      const issue = targets.get(parent);
      const decision = { issue_number: parent, ...group.new_parent };
      const original = { ...issue, labels: [] };
      expectedPriorities.set(parent, decision.priority);
      await applyPriority({ client, snapshot, issue: original, decision, runUrl, result, onProgress });
      result.decisions.push({
        issue_number: parent, priority: decision.priority, reason: decision.reason, blockers: decision.blockers,
      });
    }
    const links = await client.list("/issues/{issue_number}/sub_issues", { issue_number: parent });
    for (const child of group.children) {
      if (links.some((issue) => issue.id === targets.get(child).id)) continue;
      const raw = await client.get("/issues/{issue_number}", { issue_number: child });
      check(raw.state === "open" && raw.id === targets.get(child).id, `Child #${child} changed before linking`);
      const existingParent = await parentOf(client, raw);
      check(!existingParent || reference(existingParent, snapshot.repository) === `${snapshot.repository}#${parent}`,
        `Child #${child} now has a different parent; refusing to reparent it`);
      await client.write("POST", "/issues/{issue_number}/sub_issues", {
        issue_number: parent, sub_issue_id: targets.get(child).id, replace_parent: false,
      });
      await onProgress({ operation: "link-child", parent, child });
    }
    const linked = await client.list("/issues/{issue_number}/sub_issues", { issue_number: parent });
    check(group.children.every((child) => linked.some((item) => item.id === targets.get(child).id)),
      `Failed to verify sub-issues for parent #${parent}`);
    result.groups.push({ key: group.key, parent, children: group.children, reason: group.reason });
  }
  for (const [issueNumber] of targets) {
    const final = await client.get("/issues/{issue_number}", { issue_number: issueNumber });
    check(final.state === "open" && same(managed(final.labels.map((label) => label.name)), [expectedPriorities.get(issueNumber)]),
      `Final priority verification failed for #${issueNumber}`);
  }
  const openNumbers = (await client.list("/issues", { state: "open" })).filter((issue) => !issue.pull_request)
    .map((issue) => issue.number).sort((a, b) => a - b);
  check(same(openNumbers, [...targets.keys()].sort((a, b) => a - b)),
    "Open issue set changed during application; partial progress is recorded, run triage again");
  return result;
}

function summary(result) {
  const cell = (value) => sanitize(String(value)).replace(/[<>]/g, (character) => character === "<" ? "&lt;" : "&gt;")
    .replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return `## AI issue priority triage${result.preview ? " (preview: no changes made)" : ""}\n\n` +
    `${result.changed.length} ${result.preview ? "proposed changes" : "changes"}, ${result.unchanged.length} unchanged issues.\n\n` +
    `| Issue | Priority | Reason | Prerequisites |\n| --- | --- | --- | --- |\n` +
    result.decisions.map((decision) =>
      `| #${decision.issue_number} | ${decision.priority} | ${cell(decision.reason)} | ${cell(decision.blockers.map((item) => item.issue).join(", "))} |`)
      .join("\n") +
    `\n\n### Groups\n\n${result.groups.map((group) =>
      `- ${group.parent === "new" ? "New parent" : `#${group.parent}`} (${cell(group.key)}): ${group.children.map((child) => `#${child}`).join(", ")}. ${cell(group.reason)}` +
      (group.new_parent ? ` Priority: ${group.new_parent.priority}. ${cell(group.new_parent.reason)}` : "")).join("\n") || "No new group operations."}\n` +
    `\n${result.created_labels.length ? `Managed labels ${result.preview ? "to create" : "created"}: ${result.created_labels.join(", ")}.\n` : ""}`;
}

module.exports = { PRIORITIES, collectSnapshot, validatePlan, extractPlan, isStagedRun, applyPlan, summary };
