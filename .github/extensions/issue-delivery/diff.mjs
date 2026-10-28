const MAX_LINES = 8_000;
const MAX_FILES = 100;

// Git quotes paths with C escapes and octal-encoded UTF-8 bytes.
export function gitPath(value) {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error("Unterminated quoted Git path.");
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\\": 92, '"': 34 };
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== "\\") {
      const character = String.fromCodePoint(value.codePointAt(i));
      bytes.push(...new TextEncoder().encode(character));
      i += character.length - 1;
    } else {
      const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1));
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; }
      else {
        const code = escapes[value[++i]];
        if (code === undefined) throw new Error("Unsupported Git path escape.");
        bytes.push(code);
      }
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}

function headerPaths(line) {
  const body = line.slice(11);
  if (body.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") (.+)$/.exec(body);
    if (!match) throw new Error("Unsupported Git file header.");
    return [gitPath(match[1]), gitPath(match[2])];
  }
  // Git leaves spaces unquoted; an unchanged path can itself contain " b/".
  const candidates = [...body.matchAll(/ b\//g)].map((match) => [body.slice(0, match.index), body.slice(match.index + 1)]);
  const pair = candidates.find(([oldPath, newPath]) => oldPath.slice(2) === newPath.slice(2)) ?? candidates[0];
  if (pair) return pair;
  const quotedNew = body.indexOf(' "');
  if (quotedNew !== -1) return [body.slice(0, quotedNew), gitPath(body.slice(quotedNew + 1))];
  throw new Error("Unsupported Git file header.");
}

export function parsePatch(text) {
  const files = [];
  let current;
  let hunk;
  let limited = false;
  let error = null;
  const finishHunk = () => {
    if (hunk && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0)) throw new Error("Incomplete unified diff hunk.");
    hunk = null;
  };
  try {
    let count = 0;
    for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
      if (!match[0]) break;
      if (++count > MAX_LINES) { limited = true; break; }
      const line = match[0].replace(/\n$/, "");
      if (line.startsWith("diff --git ")) {
        finishHunk();
        if (files.length >= MAX_FILES) { limited = true; break; }
        const [oldPath, newPath] = headerPaths(line);
        current = { oldPath: oldPath.replace(/^a\//, ""), path: newPath.replace(/^b\//, ""), status: "modified", lines: [], binary: false };
        files.push(current);
      } else if (!current) {
        if (line.trim()) throw new Error("Only recorded Git unified patches are supported.");
      } else if (line.startsWith("@@ ")) {
        finishHunk();
        const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!range) throw new Error("Invalid unified diff range.");
        const numbers = [range[1], range[2] ?? "1", range[3], range[4] ?? "1"].map(Number);
        if (!numbers.every(Number.isSafeInteger)) throw new Error("Diff range exceeds supported line numbers.");
        hunk = { old: numbers[0], oldRemaining: numbers[1], next: numbers[2], newRemaining: numbers[3] };
        current.lines.push({ type: "hunk", text: line });
      } else if (hunk && /^[ +\-]/.test(line)) {
        const type = line[0] === "+" ? "added" : line[0] === "-" ? "deleted" : "context";
        const old = type === "added" ? null : hunk.old++;
        const next = type === "deleted" ? null : hunk.next++;
        if (old !== null) hunk.oldRemaining--;
        if (next !== null) hunk.newRemaining--;
        if (hunk.oldRemaining < 0 || hunk.newRemaining < 0) throw new Error("Diff lines exceed the recorded hunk range.");
        current.lines.push({ type, old, next, text: line.slice(1) });
      } else if (line.startsWith("\\ No newline at end of file")) {
        current.lines.push({ type: "note", text: line });
      } else {
        finishHunk();
        if (line.startsWith("new file mode ")) current.status = "added";
        else if (line.startsWith("deleted file mode ")) current.status = "deleted";
        else if (line.startsWith("rename from ")) { current.oldPath = gitPath(line.slice(12)); current.status = "renamed"; }
        else if (line.startsWith("rename to ")) { current.path = gitPath(line.slice(10)); current.status = "renamed"; }
        else if (line.startsWith("copy from ")) { current.oldPath = gitPath(line.slice(10)); current.status = "copied"; }
        else if (line.startsWith("copy to ")) { current.path = gitPath(line.slice(8)); current.status = "copied"; }
        else if (line.startsWith("--- ") && line.slice(4) !== "/dev/null") current.oldPath = gitPath(line.slice(4).replace(/\t$/, "")).replace(/^a\//, "");
        else if (line.startsWith("+++ ") && line.slice(4) !== "/dev/null") current.path = gitPath(line.slice(4).replace(/\t$/, "")).replace(/^b\//, "");
        if (line === "GIT binary patch" || line.startsWith("Binary files ")) current.binary = true;
        if (current.binary) {
          if (line === "GIT binary patch" || line.startsWith("Binary files ")) current.lines.push({ type: "note", text: "Binary content changed. Inspect Raw for the recorded patch." });
        } else if (line) current.lines.push({ type: "meta", text: line });
      }
    }
    if (!limited) finishHunk();
  } catch (failure) {
    error = failure.message;
  }
  return { files, limited, error };
}

export function changedFileStatuses(paths, patch, manifest) {
  const parsed = typeof patch === "string" ? parsePatch(patch) : null;
  // A malformed patch is not evidence that a file has a particular status.
  const statuses = new Map(parsed && !parsed.error ? parsed.files.map((file) => [file.path, file.status]) : []);
  if (parsed && !parsed.error) for (const file of parsed.files) {
    if (file.status === "renamed") statuses.set(file.oldPath, "renamed");
  }
  const added = new Set(Array.isArray(manifest) ? manifest.filter((entry) => entry && typeof entry.path === "string").map((entry) => entry.path) : []);
  const recordedPaths = parsed && !parsed.error ? parsed.files.map((file) => file.path) : [];
  return [...new Set([...paths.filter((entry) => typeof entry === "string"), ...recordedPaths, ...added])]
    .map((path) => ({ path, status: added.has(path) ? "added" : statuses.get(path) ?? "unclassified" }));
}
