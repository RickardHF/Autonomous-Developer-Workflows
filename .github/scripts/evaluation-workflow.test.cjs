const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");

const repository = resolve(__dirname, "../..");
const { parseDocument } = createRequire(join(repository, "evaluator/package.json"))("yaml");
const document = parseDocument(readFileSync(join(repository, ".github/workflows/evaluate.yml"), "utf8"));
assert.deepEqual(document.errors, []);
const workflow = document.toJS();
const steps = workflow.jobs.evaluate.steps;
const step = (id) => {
  const value = steps.find((entry) => entry.id === id);
  assert.ok(value, `Missing workflow step ${id}`);
  return value;
};
const publisher = step("publish_badge");
const generator = step("generate_badge");
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "evaluation-workflow-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const remote = join(directory, "remote.git");
  const runnerTemp = join(directory, "runner");
  mkdirSync(source);
  mkdirSync(runnerTemp);
  mkdirSync(join(source, "evaluator"));
  git(directory, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(source, "init", "--quiet", "--initial-branch=main");
  git(source, "config", "user.name", "Workflow fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "eval-badge.svg"), "<svg>old tracked badge</svg>\n");
  git(source, "add", "eval-badge.svg");
  git(source, "commit", "--quiet", "-m", "Source fixture");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "--quiet", "origin", "main");
  const main = git(source, "rev-parse", "HEAD");
  const badge = join(runnerTemp, "evaluation-output", "eval-badge.svg");
  const output = join(runnerTemp, "step-output");
  writeFileSync(output, "");
  return {
    directory, source, remote, runnerTemp, main, badge, output,
    env: {
      ...gitEnvironment,
      RUNNER_TEMP: runnerTemp,
      SOURCE_SHA: main,
      SOURCE_REF: "refs/heads/main",
      BADGE_PATH: badge,
      GITHUB_OUTPUT: output,
    },
    writeBadge(content = "<svg>fresh badge</svg>\n") {
      mkdirSync(join(runnerTemp, "evaluation-output"), { recursive: true });
      writeFileSync(badge, content);
    },
    run(run = publisher.run, overrides = {}, cwd = source) {
      return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run], {
        cwd, env: { ...this.env, ...overrides }, encoding: "utf8",
      });
    },
    published() {
      return git(source, "ls-remote", "origin", "refs/heads/evaluation-results").split("\t")[0];
    },
    mockNpx() {
      const bin = join(directory, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "npx"), `#!/bin/bash
if [ "\${MOCK_MODE:-badge}" = evaluate ]; then
  printf '%s\\n' '{"fileName":"example.agent.md","score":7,"reasoning":"Fixture"}'
  echo "Fixture evaluation diagnostic" >&2
  exit "\${MOCK_EXIT:-0}"
fi
if [ "\${MOCK_EXIT:-0}" != 0 ]; then
  echo "Fixture badge generation failed" >&2
  exit "$MOCK_EXIT"
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then
    mkdir -p "$(dirname "$2")"
    printf '%s\\n' '<svg>generated fixture</svg>' > "$2"
    exit 0
  fi
  shift
done
exit 1
`, { mode: 0o755 });
      return `${bin}:${process.env.PATH}`;
    },
  };
}

test("workflow evaluates every main push, cancels superseded runs, and gates publishing on success", () => {
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.concurrency, {
    group: "evaluation-publishing-${{ github.ref }}", "cancel-in-progress": true,
  });
  assert.deepEqual(workflow.jobs.evaluate.permissions, { contents: "write", "copilot-requests": "write" });
  const checkout = steps.find((entry) => entry.uses === "actions/checkout@v7");
  assert.deepEqual(checkout.with, { ref: "${{ github.sha }}", "persist-credentials": false });
  assert.ok(steps.some((entry) => entry.uses === "./.github/actions/setup-copilot-cli"));
  assert.equal(step("run_eval").env.COPILOT_GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(generator.if, "success()");
  assert.equal(step("upload_badge").if, "success()");
  assert.equal(publisher.if, "success() && github.ref == 'refs/heads/main'");
  assert.equal(generator.env.BADGE_PATH, "${{ runner.temp }}/evaluation-output/eval-badge.svg");
  assert.equal(publisher.env.BADGE_PATH, generator.env.BADGE_PATH);
  assert.equal(step("upload_badge").with.path, generator.env.BADGE_PATH);
  assert.equal(step("upload_badge").with["if-no-files-found"], "error");
  assert.ok(steps.indexOf(generator) < steps.indexOf(step("upload_badge")));
  assert.ok(steps.indexOf(step("upload_badge")) < steps.indexOf(publisher));
  assert.equal(steps.find((entry) => entry.name === "Summary").env.SOURCE_SHA, "${{ github.sha }}");
  for (const entry of steps.filter((entry) => entry.run)) {
    const syntax = spawnSync("bash", ["-n"], { input: entry.run, encoding: "utf8" });
    assert.equal(syntax.status, 0, `${entry.name}: ${syntax.stderr}`);
  }
});

test("first publication creates an independent SVG-only branch and leaves the source checkout unchanged", (context) => {
  const f = fixture(context);
  f.writeBadge();
  const before = git(f.source, "status", "--porcelain");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const published = f.published();
  assert.ok(published);
  assert.equal(git(f.source, "--git-dir", f.remote, "ls-tree", "--name-only", published), "eval-badge.svg");
  assert.equal(git(f.source, "--git-dir", f.remote, "show", `${published}:eval-badge.svg`), "<svg>fresh badge</svg>");
  assert.equal(git(f.source, "--git-dir", f.remote, "rev-list", "--count", published), "1");
  assert.match(git(f.source, "--git-dir", f.remote, "log", "-1", "--format=%s", published), new RegExp(f.main));
  assert.equal(git(f.source, "--git-dir", f.remote, "rev-parse", "main"), f.main);
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.main);
  assert.equal(git(f.source, "status", "--porcelain"), before);
  assert.equal(readFileSync(f.output, "utf8"), "published=true\n");
  assert.ok(!readdirSync(f.runnerTemp).some((name) => name.startsWith("evaluation-publish.")));
});

test("changed SVG updates are fast-forward commits and unchanged SVGs do not create commits", (context) => {
  const f = fixture(context);
  f.writeBadge();
  assert.equal(f.run().status, 0);
  const first = f.published();
  f.writeBadge("<svg>updated badge</svg>\n");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const second = f.published();
  assert.notEqual(second, first);
  assert.equal(git(f.source, "--git-dir", f.remote, "rev-parse", `${second}^`), first);
  assert.equal(git(f.source, "--git-dir", f.remote, "show", `${second}:eval-badge.svg`), "<svg>updated badge</svg>");
  const unchanged = f.run();
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /No changes to badge/);
  assert.equal(f.published(), second);
  assert.equal(git(f.source, "--git-dir", f.remote, "rev-parse", "main"), f.main);
});

test("obsolete evaluations do not overwrite a published badge", (context) => {
  const f = fixture(context);
  f.writeBadge();
  assert.equal(f.run().status, 0);
  const published = f.published();
  git(f.source, "commit", "--quiet", "--allow-empty", "-m", "New main commit");
  git(f.source, "push", "--quiet", "origin", "main");
  f.writeBadge("<svg>obsolete badge</svg>\n");
  writeFileSync(f.output, "");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Main has advanced/);
  assert.equal(f.published(), published);
  assert.equal(readFileSync(f.output, "utf8"), "");
});

test("main advancing during the publication commit prevents a stale push", (context) => {
  const f = fixture(context);
  f.writeBadge();
  assert.equal(f.run().status, 0);
  const published = f.published();
  git(f.source, "commit", "--quiet", "--allow-empty", "-m", "Next main commit");
  const nextMain = git(f.source, "rev-parse", "HEAD");
  git(f.source, "push", "--quiet", "origin", "HEAD:refs/heads/future-main");
  const hooks = join(f.directory, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh
git --git-dir="$TEST_REMOTE" update-ref refs/heads/main "$NEXT_MAIN_SHA"
`, { mode: 0o755 });
  f.writeBadge("<svg>superseded during commit</svg>\n");
  const result = f.run(publisher.run, {
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks,
    TEST_REMOTE: f.remote, NEXT_MAIN_SHA: nextMain,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Main has advanced/);
  assert.equal(f.published(), published);
  assert.equal(git(f.source, "--git-dir", f.remote, "rev-parse", "main"), nextMain);
});

test("non-main previews cannot create or update the publishing branch", (context) => {
  const f = fixture(context);
  f.writeBadge();
  const preview = f.run(publisher.run, { SOURCE_REF: "refs/heads/feature" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Only main/);
  assert.equal(f.published(), "");
  assert.equal(f.run().status, 0);
  const published = f.published();
  f.writeBadge("<svg>feature preview</svg>\n");
  assert.equal(f.run(publisher.run, { SOURCE_REF: "refs/heads/feature" }).status, 0);
  assert.equal(f.published(), published);
});

test("the badge CLI creates an SVG in the fresh output directory without touching the tracked image", (context) => {
  const f = fixture(context);
  const input = join(f.directory, "results.jsonl");
  writeFileSync(input, `${JSON.stringify({
    fileName: ".github/agents/example.agent.md", score: 7, reasoning: "Fixture evaluation",
  })}\n`);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "cli.ts", "badge", "--input", input,
    "--output", f.badge, "--date", "fixture-run",
  ], { cwd: join(repository, "evaluator"), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const svg = readFileSync(f.badge, "utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /7\/10/);
  assert.match(svg, /fixture-run/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(readFileSync(join(f.source, "eval-badge.svg"), "utf8"), "<svg>old tracked badge</svg>\n");
  assert.equal(f.run().status, 0);
  assert.equal(git(f.source, "--git-dir", f.remote, "show", `${f.published()}:eval-badge.svg`), svg);
});

test("generation uses fresh run output and failures cannot publish the tracked root badge", (context) => {
  const f = fixture(context);
  const path = f.mockNpx();
  const failed = f.run(generator.run, { PATH: path, MOCK_EXIT: "1" }, join(f.source, "evaluator"));
  assert.notEqual(failed.status, 0);
  assert.ok(!existsSync(f.badge));
  const publication = f.run();
  assert.notEqual(publication.status, 0);
  assert.match(publication.stdout, /No generated badge/);
  assert.equal(f.published(), "");
  assert.equal(readFileSync(join(f.source, "eval-badge.svg"), "utf8"), "<svg>old tracked badge</svg>\n");
  const success = f.run(generator.run, { PATH: path }, join(f.source, "evaluator"));
  assert.equal(success.status, 0, success.stderr);
  assert.equal(readFileSync(f.badge, "utf8"), "<svg>generated fixture</svg>\n");
  assert.equal(f.run().status, 0);
});

test("evaluation process failures propagate while per-definition diagnostics retain current behavior", (context) => {
  const f = fixture(context);
  const path = f.mockNpx();
  const run = step("run_eval").run.replaceAll("${{ github.workspace }}", f.source);
  const failed = f.run(run, { PATH: path, MOCK_MODE: "evaluate", MOCK_EXIT: "1" }, join(f.source, "evaluator"));
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stdout, /done/);
  const warning = f.run(run, { PATH: path, MOCK_MODE: "evaluate" }, join(f.source, "evaluator"));
  assert.equal(warning.status, 0, warning.stderr);
  assert.match(readFileSync(join(f.source, "evaluator", "eval_errors.txt"), "utf8"), /Fixture evaluation diagnostic/);
  assert.match(warning.stdout, /done/);
});

test("missing or empty generated output leaves an existing published badge unchanged", (context) => {
  const f = fixture(context);
  f.writeBadge();
  assert.equal(f.run().status, 0);
  const published = f.published();
  rmSync(f.badge);
  assert.notEqual(f.run().status, 0);
  assert.equal(f.published(), published);
  f.writeBadge("");
  assert.notEqual(f.run().status, 0);
  assert.equal(f.published(), published);
});

test("missing remote main and rejected publishing pushes fail explicitly", (context) => {
  const f = fixture(context);
  f.writeBadge();
  assert.equal(f.run().status, 0);
  const published = f.published();
  git(f.source, "--git-dir", f.remote, "update-ref", "-d", "refs/heads/main");
  f.writeBadge("<svg>cannot publish</svg>\n");
  const missingMain = f.run();
  assert.notEqual(missingMain.status, 0);
  assert.match(missingMain.stderr, /Remote main branch not found/);
  assert.equal(f.published(), published);
  git(f.source, "--git-dir", f.remote, "update-ref", "refs/heads/main", f.main);
  writeFileSync(join(f.remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'Publication rejected' >&2\nexit 1\n", { mode: 0o755 });
  const rejected = f.run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Publication rejected/);
  assert.equal(f.published(), published);
  assert.equal(git(f.source, "--git-dir", f.remote, "rev-parse", "main"), f.main);
});

test("remote access failures are not reported as successful publication", (context) => {
  const f = fixture(context);
  f.writeBadge();
  git(f.source, "remote", "set-url", "origin", join(f.directory, "missing.git"));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not appear to be a git repository/);
  assert.equal(readFileSync(f.output, "utf8"), "");
});

test("badge summaries distinguish publication, preview artifacts, and failures", (context) => {
  const f = fixture(context);
  const summary = join(f.runnerTemp, "summary.md");
  const run = steps.find((entry) => entry.name === "Badge summary").run;
  const env = {
    GITHUB_STEP_SUMMARY: summary,
    BADGE_URL: "https://raw.githubusercontent.com/example/project/evaluation-results/eval-badge.svg",
    RUN_URL: "https://github.com/example/project/actions/runs/1",
    PUBLISHED: "", UPLOAD_OUTCOME: "success",
  };
  const preview = f.run(run, env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(readFileSync(summary, "utf8"), /eval-badge artifact.*The published badge was not updated/);
  assert.doesNotMatch(readFileSync(summary, "utf8"), /!\[Evaluation Badge\]/);
  writeFileSync(summary, "");
  assert.equal(f.run(run, { ...env, PUBLISHED: "true" }).status, 0);
  assert.equal(readFileSync(summary, "utf8"), `![Evaluation Badge](${env.BADGE_URL})\n`);
  writeFileSync(summary, "");
  assert.equal(f.run(run, { ...env, UPLOAD_OUTCOME: "skipped" }).status, 0);
  assert.match(readFileSync(summary, "utf8"), /No badge was published/);
});
