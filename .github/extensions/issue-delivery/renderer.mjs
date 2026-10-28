import { changedFileStatuses, parsePatch } from "./diff.mjs";

export function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

export function safeLink(text) {
  try {
    const url = new URL(text);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function badge(doc, text) {
  const node = element(doc, "span", text, "badge");
  const state = String(text).toLowerCase();
  if (["successful", "passed", "pass", "met", "complete", "completed", "ready"].includes(state)) node.dataset.color = "green";
  else if (["unsuccessful", "failed", "fail", "not-met", "error", "critical", "high"].includes(state)) node.dataset.color = "red";
  else if (["running", "active", "in progress"].includes(state)) node.dataset.color = "blue";
  else if (["inconclusive", "blocked", "unverified", "closed unfinished", "paused", "halted", "cancelled", "not-run", "needs-verification", "medium"].includes(state)) node.dataset.color = "yellow";
  else node.dataset.color = "gray";
  return node;
}

export function icon(doc, name) {
  const paths = {
    workflow: ["M4 5h5v5H4zM15 14h5v5h-5zM9 7h6a3 3 0 0 1 3 3v4M6.5 10v7h8.5"],
    refresh: ["M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"],
    check: ["m6 12 4 4 8-8"], error: ["m7 7 10 10M17 7 7 17"],
    pause: ["M9 6v12M15 6v12"], chevron: ["m9 6 6 6-6 6"],
    file: ["M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h4"],
    branch: ["M7 3v12a3 3 0 1 0 3 3M7 12h6a4 4 0 0 0 4-4V3"],
    activity: ["M3 12h4l3-7 4 14 3-7h4"],
    external: ["M14 3h7v7M21 3 10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"],
    info: ["M12 11v6M12 7v.1", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
  };
  const node = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: "icon" })) node.setAttribute(key, value);
  for (const data of paths[name] ?? paths.file) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data); node.append(path);
  }
  return node;
}

export const label = (key) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
const statusKeys = new Set(["status", "verdict", "outcome", "recommendation", "maximumRecommendation", "severity"]);

export function renderValue(doc, value, depth = 0, key = "", budget = { remaining: 2_000 }) {
  if (--budget.remaining < 0) return element(doc, "p", "Preview limit reached. Use Raw to inspect the full value.", "muted");
  if (value === null || typeof value !== "object") {
    return statusKeys.has(key) && typeof value === "string" ? badge(doc, value)
      : element(doc, "span", value === null ? "null" : value, "value");
  }
  if (depth > 8) return element(doc, "p", "Nested preview limited. Use Raw to inspect the full value.", "muted");
  if (Array.isArray(value)) {
    if (!value.length) return element(doc, "span", "None", "muted");
    const list = element(doc, "ul", undefined, "value-list");
    for (const entry of value.slice(0, 100)) {
      const item = element(doc, "li");
      if (entry !== null && typeof entry === "object") {
        const details = element(doc, "details");
        const title = entry.title ?? entry.requirement ?? entry.command ?? entry.path ?? entry.id ?? "Details";
        const summary = element(doc, "summary", title);
        const status = entry.severity ?? entry.status ?? entry.outcome;
        if (typeof status === "string") summary.prepend(badge(doc, status), doc.createTextNode(" "));
        details.append(summary, renderValue(doc, entry, depth + 1, "", budget));
        item.append(details);
      } else item.append(renderValue(doc, entry, depth + 1, "", budget));
      list.append(item);
      if (budget.remaining < 0) break;
    }
    if (value.length > 100) list.append(element(doc, "li", `${value.length - 100} more entries. Use Raw to inspect all entries.`, "muted"));
    return list;
  }
  const fields = element(doc, "dl", undefined, "fields");
  for (const [name, entry] of Object.entries(value).slice(0, 100)) {
    fields.append(element(doc, "dt", label(name)), element(doc, "dd"));
    fields.lastChild.append(renderValue(doc, entry, depth + 1, name, budget));
    if (budget.remaining < 0) break;
  }
  if (Object.keys(value).length > 100) fields.append(element(doc, "dt", "Preview limit"), element(doc, "dd", "More fields are available in Raw."));
  return fields;
}

export function inlineTokens(text) {
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  const tokens = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) tokens.push({ type: "text", text: text.slice(end, match.index) });
    tokens.push(match[1] !== undefined ? { type: "code", text: match[1] }
      : match[2] !== undefined ? { type: "link", text: match[2], href: safeLink(match[3]) }
      : { type: match[4] !== undefined ? "strong" : "em", text: match[4] ?? match[5] });
    end = match.index + match[0].length;
  }
  if (end < text.length) tokens.push({ type: "text", text: text.slice(end) });
  return tokens;
}

const tableCells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
const tableRule = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
const listLine = (line) => /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
const blockStart = (line) => /^(?:#{1,6}\s|```|~~~|\s*$)/.test(line) || listLine(line);

export function markdownBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    if (!line.trim()) continue;
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const code = [];
      while (i < lines.length && !lines[i].startsWith(fence[1])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: "code", text: code.join("\n") });
    } else if (/^#{1,6}\s/.test(line)) {
      const [, hashes, text] = /^(#{1,6})\s+(.*)$/.exec(line);
      blocks.push({ type: `h${hashes.length}`, text });
    } else if (i < lines.length && tableRule(lines[i])) {
      i++;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(tableCells(lines[i++]));
      blocks.push({ type: "table", header: tableCells(line), rows });
    } else if (listLine(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")];
      while (i < lines.length && listLine(lines[i]) && /^\s*\d+\./.test(lines[i]) === ordered) {
        items.push(lines[i++].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""));
      }
      blocks.push({ type: ordered ? "ol" : "ul", items });
    } else {
      const paragraph = [line];
      while (i < lines.length && !blockStart(lines[i]) && !(i + 1 < lines.length && tableRule(lines[i + 1]))) paragraph.push(lines[i++]);
      blocks.push({ type: "p", text: paragraph.join("\n") });
    }
  }
  return blocks;
}

function appendInline(doc, node, text) {
  for (const token of inlineTokens(text)) {
    if (token.type === "text" || token.type === "link" && !token.href) node.append(doc.createTextNode(token.text));
    else {
      const child = element(doc, token.type === "link" ? "a" : token.type, token.text);
      if (token.type === "link") {
        child.href = token.href;
        child.target = "_blank";
        child.rel = "noopener noreferrer";
      }
      node.append(child);
    }
  }
}

export function renderMarkdown(doc, text) {
  const container = element(doc, "div", undefined, "markdown");
  const blocks = markdownBlocks(text.slice(0, 100_000));
  const limited = text.length > 100_000 || blocks.length > 1_000 ||
    blocks.some((block) => (block.items?.length ?? 0) > 500 || (block.rows?.length ?? 0) > 500 ||
      (block.header?.length ?? 0) > 40 || block.rows?.some((row) => row.length > 40));
  if (limited) container.append(element(doc, "p", "Rendered preview limited. Raw contains the full artifact.", "notice"));
  for (const block of blocks.slice(0, 1_000)) {
    if (block.type === "code") container.append(element(doc, "pre", block.text));
    else if (block.type === "table") {
      const wrapper = element(doc, "div", undefined, "table-scroll");
      const table = element(doc, "table");
      const head = element(doc, "thead");
      const row = element(doc, "tr");
      for (const text of block.header.slice(0, 40)) { const cell = element(doc, "th"); cell.scope = "col"; appendInline(doc, cell, text); row.append(cell); }
      head.append(row);
      const body = element(doc, "tbody");
      for (const cells of block.rows.slice(0, 500)) {
        const row = element(doc, "tr");
        for (const text of cells.slice(0, 40)) { const cell = element(doc, "td"); appendInline(doc, cell, text); row.append(cell); }
        body.append(row);
      }
      table.append(head, body); wrapper.append(table); container.append(wrapper);
    } else if (block.items) {
      const list = element(doc, block.type);
      for (const text of block.items.slice(0, 500)) { const item = element(doc, "li"); appendInline(doc, item, text); list.append(item); }
      container.append(list);
    } else {
      const node = element(doc, block.type);
      appendInline(doc, node, block.text);
      container.append(node);
    }
  }
  return container;
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const previewBudget = () => ({ characters: 100_000, entries: 500, limited: false });
const changeLabels = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed", copied: "Copied", unclassified: "Status unavailable" };

function prose(doc, value, budget) {
  if (typeof value !== "string") return renderValue(doc, value);
  const text = value.slice(0, Math.max(0, budget.characters));
  budget.characters -= text.length;
  if (text.length !== value.length) budget.limited = true;
  return renderMarkdown(doc, text);
}

function bounded(entries, budget) {
  const result = entries.slice(0, Math.min(100, Math.max(0, budget.entries)));
  budget.entries -= result.length;
  if (result.length !== entries.length) budget.limited = true;
  return result;
}

function valueList(doc, value, budget, ordered = false) {
  if (!Array.isArray(value)) return prose(doc, value, budget);
  if (!value.length) return element(doc, "p", "None recorded.", "muted");
  const list = element(doc, ordered ? "ol" : "ul", undefined, "report-list");
  for (const entry of bounded(value, budget)) {
    const item = element(doc, "li");
    item.append(prose(doc, entry, budget)); list.append(item);
  }
  return list;
}

function section(doc, title, child) {
  const node = element(doc, "section", undefined, "document-section");
  node.append(element(doc, "h3", title), child);
  return node;
}

function table(doc, title, columns, rows, budget) {
  if (!Array.isArray(rows)) return prose(doc, rows, budget);
  if (!rows.length) return element(doc, "p", `No ${title.toLowerCase()} recorded.`, "muted");
  const wrapper = element(doc, "div", undefined, "table-scroll");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("aria-label", title);
  const node = element(doc, "table", undefined, "evidence-table");
  node.append(element(doc, "caption", title, "sr-only"));
  const head = element(doc, "thead");
  const headings = element(doc, "tr");
  for (const [title] of columns) {
    const cell = element(doc, "th", title); cell.scope = "col"; headings.append(cell);
  }
  head.append(headings);
  const body = element(doc, "tbody");
  for (const entry of bounded(rows, budget)) {
    const row = element(doc, "tr");
    if (!object(entry)) {
      const cell = element(doc, "td");
      cell.colSpan = columns.length;
      cell.append(element(doc, "p", "Unexpected record; inspect Raw.", "notice"), renderValue(doc, entry));
      row.append(cell);
    } else for (const [, render] of columns) {
      const cell = element(doc, "td");
      cell.append(render(entry)); row.append(cell);
    }
    body.append(row);
  }
  node.append(head, body); wrapper.append(node);
  return wrapper;
}

function timestamp(doc, value) {
  const valid = typeof value === "string" && Number.isFinite(Date.parse(value));
  const node = element(doc, "time", valid ? `Updated ${new Date(value).toLocaleString()}` : "Update time not recorded", "document-updated");
  if (valid) { node.dateTime = value; node.title = value; }
  return node;
}

function link(doc, value, className = "document-link") {
  const href = safeLink(value);
  const node = element(doc, href ? "a" : "span", typeof value === "string" ? value : "URL not recorded", className);
  if (href) { node.href = href; node.target = "_blank"; node.rel = "noopener noreferrer"; }
  return node;
}

function issueArticle(doc, title, value, updated, budget, className) {
  const article = element(doc, "article", undefined, className);
  const header = element(doc, "header", undefined, "document-header");
  header.append(element(doc, "h3", title), timestamp(doc, updated));
  article.append(header, link(doc, value.url));
  article.append(typeof value.body === "string" && value.body.trim()
    ? prose(doc, value.body, budget) : element(doc, "p", "No body provided.", "muted"));
  return article;
}

function issuePreview(doc, value, budget) {
  const node = element(doc, "div", undefined, "issue-document");
  node.append(issueArticle(doc, `#${value.number ?? "?"} ${value.title ?? "Untitled issue"}`, value, value.updatedAt, budget, "issue-article"));
  const comments = element(doc, "section", undefined, "issue-comments");
  comments.append(element(doc, "h3", "Comments"));
  if (Array.isArray(value.comments)) {
    if (!value.comments.length) comments.append(element(doc, "p", "No comments captured.", "muted"));
    for (const [index, comment] of bounded(value.comments, budget).entries()) {
      if (object(comment)) comments.append(issueArticle(doc, `Comment ${comment.id ?? index + 1}`, comment, comment.updated_at, budget, "comment-article"));
      else comments.append(element(doc, "p", "Unexpected comment record. Inspect Raw.", "notice"), renderValue(doc, comment));
    }
  } else comments.append(element(doc, "p", "Comments are missing or unavailable. Inspect Raw.", "notice"));
  node.append(comments);
  return node;
}

function titledValue(doc, key, value, budget, depth = 0) {
  if (depth > 8) { budget.limited = true; return element(doc, "p", "Nested preview limited. Inspect Raw.", "muted"); }
  if (key === "findings") return dispositionTable(doc, value, budget);
  if (object(value)) {
    const node = element(doc, "div", undefined, "document-sections");
    for (const [name, entry] of bounded(Object.entries(value), budget)) node.append(section(doc, label(name), titledValue(doc, name, entry, budget, depth + 1)));
    return node;
  }
  if (Array.isArray(value)) return valueList(doc, value, budget, key === "steps");
  if (typeof value === "boolean") return element(doc, "p", value ? "Yes" : "No");
  if (statusKeys.has(key) && typeof value === "string") return badge(doc, value);
  if (key === "issueUrl" || key === "url") return link(doc, value);
  return prose(doc, value, budget);
}

function planPreview(doc, value, budget) {
  const node = element(doc, "div", undefined, "artifact-document");
  if (typeof value.status === "string") node.append(badge(doc, value.status));
  const names = ["goal", "scope", "acceptanceCriteria", "steps", "mitigations", "rollback", "validationRequired", "blockers"];
  for (const name of names) {
    if (!Object.hasOwn(value, name)) continue;
    const content = name === "acceptanceCriteria" ? table(doc, "Acceptance criteria", [
      ["ID", (row) => element(doc, "code", row.id)],
      ["Requirements", (row) => prose(doc, row.requirement, budget)],
      ["Verification", (row) => prose(doc, row.verification, budget)],
    ], value[name], budget) : titledValue(doc, name, value[name], budget);
    node.append(section(doc, label(name), content));
  }
  extraNotice(doc, node, value, ["status", ...names]);
  return node;
}

function extraNotice(doc, node, value, known) {
  if (Object.keys(value).some((key) => !known.includes(key))) node.append(element(doc, "p", "Additional properties are available in Raw.", "muted"));
}

function checksTable(doc, rows, budget) {
  return table(doc, "Validation checks", [
    ["Command", (row) => element(doc, "code", row.command)],
    ["Outcome", (row) => badge(doc, row.outcome ?? "Not recorded")],
    ["Evidence", (row) => prose(doc, row.evidence, budget)],
  ], rows, budget);
}

function findingsTable(doc, rows, budget) {
  return table(doc, "Review findings", [
    ["Finding", (row) => {
      const node = element(doc, "div", undefined, "finding-detail");
      node.append(element(doc, "code", row.id), element(doc, "strong", row.title), prose(doc, row.explanation, budget));
      const evidence = element(doc, "details");
      evidence.append(element(doc, "summary", "Evidence"), prose(doc, row.evidence, budget));
      node.append(evidence); return node;
    }],
    ["Severity", (row) => badge(doc, row.severity ?? "Not recorded")],
    ["Location", (row) => element(doc, "code", row.file ? `${row.file}:${row.startLine ?? "?"}-${row.endLine ?? "?"}` : "No file location")],
    ["Confidence", (row) => element(doc, "span", typeof row.confidence === "number" ? `${row.confidence}/10` : "Not recorded")],
    ["Blocking", (row) => element(doc, "span", typeof row.blocking === "boolean" ? row.blocking ? "Yes" : "No" : "Not recorded")],
  ], rows, budget);
}

function dispositionTable(doc, rows, budget) {
  return table(doc, "Finding dispositions", [
    ["Source", (row) => element(doc, "span", row.source)],
    ["ID", (row) => element(doc, "code", row.id)],
    ["Disposition", (row) => badge(doc, row.disposition ?? "Not recorded")],
    ["Reason", (row) => prose(doc, row.reason, budget)],
  ], rows, budget);
}

function reportPreview(doc, value, budget, implementation) {
  const node = element(doc, "div", undefined, "output-report");
  if (value.available !== true || !object(value.output)) {
    node.append(element(doc, "p", "Agent output is unavailable or invalid. This is not a passing result. Inspect Raw for the recorded artifact.", "notice"));
    return node;
  }
  const output = value.output;
  const required = implementation ? ["status", "summary", "changes", "checks", "deviations", "blockers"]
    : ["verdict", "summary", "coverage", "findings", "checks", "criteria"];
  if (required.some((key) => !Object.hasOwn(output, key))) {
    node.append(element(doc, "p", "Agent output is incomplete. Missing fields are not evidence of a passing result. Inspect Raw.", "notice"));
  }
  if (typeof (output.status ?? output.verdict) === "string") node.append(badge(doc, output.status ?? output.verdict));
  const names = implementation ? ["summary", "changes", "checks", "deviations", "blockers"] : ["summary", "coverage", "findings", "checks", "criteria"];
  for (const name of names) {
    if (!Object.hasOwn(output, name)) continue;
    // Omit empty report groups, but give empty findings an explicit scope-limited statement.
    if (Array.isArray(output[name]) && !output[name].length && name !== "findings") continue;
    const group = element(doc, "div", undefined, name === "blockers" ? "report-group notice" : "report-group");
    group.setAttribute("aria-label", label(name));
    group.append(name === "checks" ? checksTable(doc, output[name], budget)
      : name === "findings" ? findingsTable(doc, output[name], budget)
      : name === "criteria" ? table(doc, "Acceptance evidence", [
        ["ID", (row) => element(doc, "code", row.id)],
        ["Status", (row) => badge(doc, row.status ?? "Not recorded")],
        ["Evidence", (row) => prose(doc, row.evidence, budget)],
      ], output[name], budget)
      : Array.isArray(output[name]) ? valueList(doc, output[name], budget) : prose(doc, output[name], budget));
    node.append(group);
  }
  extraNotice(doc, node, output, ["status", "verdict", ...names]);
  extraNotice(doc, node, value, ["available", "output", ...(implementation ? ["changedFiles"] : [])]);
  return node;
}

export function renderChangedFiles(doc, paths, evidence = {}) {
  const node = element(doc, "section", undefined, "changed-files");
  node.append(element(doc, "h3", "Changed files"));
  for (const message of evidence.warnings ?? []) node.append(element(doc, "p", message, "notice"));
  if (!Array.isArray(paths)) { node.append(element(doc, "p", "Changed-file list is missing or invalid. Inspect Raw.", "notice")); return node; }
  const entries = changedFileStatuses(paths, evidence.patch, evidence.manifest);
  if (!entries.length) node.append(element(doc, "p", "No changed files recorded.", "muted"));
  const list = element(doc, "ul", undefined, "changed-file-list");
  for (const entry of entries.slice(0, 100)) {
    const row = element(doc, "li", undefined, "changed-file");
    row.dataset.change = entry.status;
    row.append(element(doc, "code", entry.path), element(doc, "span", changeLabels[entry.status], "change-label"));
    list.append(row);
  }
  if (entries.length > 100) node.append(element(doc, "p", "File list preview limited. Inspect Raw and the recorded patch.", "notice"));
  node.append(list);
  const parsed = typeof evidence.patch === "string" ? parsePatch(evidence.patch) : null;
  if (parsed?.error || parsed?.limited) node.append(element(doc, "p", "Patch evidence is incomplete or unsupported; some file statuses may be unavailable. Inspect Source changes / Raw.", "notice"));
  if (Array.isArray(evidence.manifest) && evidence.manifest.length) node.append(element(doc, "p", "New-file paths were recorded, but their contents were not captured in the patch.", "muted"));
  return node;
}

export function renderCheckout(doc, value, raw) {
  const node = element(doc, "section", undefined, "checkout-strip");
  node.setAttribute("aria-label", "Reviewed checkout");
  if (!object(value)) node.append(element(doc, "p", "Reviewed checkout metadata is invalid. Inspect Raw.", "notice"));
  else {
    const identity = element(doc, "div", undefined, "checkout-identity");
    identity.append(icon(doc, "branch"), element(doc, "strong", value.branch ?? "Branch not recorded"));
    for (const [name, title] of [["head", "Reviewed revision"], ["fingerprint", "Reviewed fingerprint"]]) {
      const code = element(doc, "code", typeof value[name] === "string" ? value[name] : "Not recorded");
      code.title = `${title}: ${value[name] ?? "Not recorded"}`; code.setAttribute("aria-label", code.title);
      identity.append(code);
    }
    node.append(identity);
    if (Object.hasOwn(value, "note")) node.append(element(doc, "p", value.note, "muted"));
  }
  const details = element(doc, "details", undefined, "checkout-raw");
  details.append(element(doc, "summary", "Raw checkout metadata"), element(doc, "pre", raw, "raw"));
  node.append(details);
  return node;
}

export function renderArtifact(doc, name, value, evidence = {}) {
  if (!object(value)) return renderValue(doc, value);
  const budget = previewBudget();
  let node;
  if (name === "issue.json") node = issuePreview(doc, value, budget);
  else if (name === "plan.json") node = planPreview(doc, value, budget);
  else if (["implementation.json", "issue-review.json", "quality-security-review.json"].includes(name)) {
    node = element(doc, "div", undefined, "artifact-document");
    if (name === "implementation.json") node.append(renderChangedFiles(doc, value.changedFiles, evidence));
    node.append(reportPreview(doc, value, budget, name === "implementation.json"));
  } else if (name === "result.json") {
    const ordered = {};
    for (const key of ["recommendation", "stage", "blockers", "synthesis", "gate", "reviewAvailability",
      "issueUrl", "branch", "baseSha", "reviewedFingerprint", "changedFiles", "artifacts"]) {
      if (Object.hasOwn(value, key)) ordered[key] = value[key];
    }
    node = titledValue(doc, "", { ...ordered, ...value }, budget);
  } else if (name === "summary.json") node = titledValue(doc, "", value, budget);
  else return renderValue(doc, value);
  if (budget.limited) node.append(element(doc, "p", "Rendered preview limited. Raw contains the full artifact.", "notice"));
  return node;
}

export function renderPatch(doc, text) {
  const node = element(doc, "div", undefined, "diff-preview");
  const parsed = parsePatch(text);
  if (parsed.error) {
    node.append(element(doc, "p", `Cannot preview this patch: ${parsed.error} Showing recorded text; Raw preserves the full patch.`, "notice"),
      element(doc, "pre", text.slice(0, 100_000), "raw"));
    if (text.length > 100_000) node.append(element(doc, "p", "Text preview limited. Use Raw for the full patch.", "notice"));
    return node;
  }
  if (!parsed.files.length) node.append(element(doc, "p", "No tracked-file changes recorded. New-file contents are not included in this patch.", "muted"));
  if (parsed.limited) node.append(element(doc, "p", "Diff preview limited. Raw contains the full patch.", "notice"));
  for (const file of parsed.files) {
    const group = element(doc, "details", undefined, "diff-file"); group.open = true;
    group.dataset.change = file.status;
    const header = element(doc, "summary", undefined, "diff-header");
    header.append(element(doc, "code", file.status === "renamed" || file.status === "copied" ? `${file.oldPath} → ${file.path}` : file.path),
      element(doc, "span", changeLabels[file.status], "change-label"));
    const wrapper = element(doc, "div", undefined, "table-scroll diff-scroll");
    wrapper.tabIndex = 0; wrapper.setAttribute("role", "region"); wrapper.setAttribute("aria-label", `Diff for ${file.path}`);
    const table = element(doc, "table", undefined, "diff-table");
    table.append(element(doc, "caption", `Unified diff for ${file.path}`, "sr-only"));
    const head = element(doc, "thead", undefined, "sr-only");
    const headings = element(doc, "tr");
    for (const title of ["Old line", "New line", "Change", "Content"]) {
      const cell = element(doc, "th", title); cell.scope = "col"; headings.append(cell);
    }
    head.append(headings);
    const body = element(doc, "tbody");
    for (const line of file.lines) {
      const row = element(doc, "tr"); row.dataset.change = line.type;
      row.append(element(doc, "td", line.old ?? "", "diff-number"), element(doc, "td", line.next ?? "", "diff-number"));
      const mark = element(doc, "td", line.type === "added" ? "+" : line.type === "deleted" ? "-" : "", "diff-mark");
      mark.setAttribute("aria-label", { added: "Added", deleted: "Deleted", context: "Context" }[line.type] ?? "Metadata");
      row.append(mark, element(doc, "td", line.text, "diff-code")); body.append(row);
    }
    table.append(head, body); wrapper.append(table); group.append(header, wrapper); node.append(group);
  }
  return node;
}
