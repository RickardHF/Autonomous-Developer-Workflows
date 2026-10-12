const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } = require("node:fs");
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
  return {
    directory, source, remote, runnerTemp, main, badge,
    env: {
      ...gitEnvironment,
      RUNNER_TEMP: runnerTemp,
      SOURCE_SHA: main,
      SOURCE_REF: "refs/heads/main",
      GITHUB_WORKSPACE: source,
      GITHUB_REPOSITORY: "example/project",
    },
    run(run = generator.run, overrides = {}, cwd = source) {
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
    mkdir -p "$2"
    printf '%s\\n' '<svg>generated fixture</svg>' > "$2/eval-badge.svg"
    exit 0
  fi
  shift
done
exit 1
`, { mode: 0o755 });
      writeFileSync(join(bin, "gh"), `#!/bin/bash
if [ "\${MOCK_PAGES_EXIT:-0}" != 0 ]; then
  echo "Fixture Pages API unavailable" >&2
  exit "$MOCK_PAGES_EXIT"
fi
printf '%s\\n' "\${MOCK_PAGES_URL:-https://example.github.io/project/}"
`, { mode: 0o755 });
      return `${bin}:${process.env.PATH}`;
    },
  };
}

test("workflow evaluates every main push with success-gated artifacts and no branch writes", () => {
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.concurrency, {
    group: "evaluation-${{ github.ref }}", "cancel-in-progress": true,
  });
  assert.deepEqual(workflow.jobs.evaluate.permissions, { contents: "read", pages: "read", "copilot-requests": "write" });
  const checkout = steps.find((entry) => entry.uses === "actions/checkout@v7");
  assert.deepEqual(checkout.with, { ref: "${{ github.sha }}", "persist-credentials": false });
  assert.ok(steps.some((entry) => entry.uses === "./.github/actions/setup-copilot-cli"));
  assert.equal(step("run_eval").env.COPILOT_GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(generator.if, "success()");
  assert.equal(step("upload_badge").if, "success()");
  assert.match(generator.run, /publication\.ts bundle/);
  assert.match(generator.run, /--directory "\$GITHUB_WORKSPACE"/);
  assert.match(generator.run, /--output "\$RUNNER_TEMP\/evaluation-output"/);
  assert.equal(step("upload_badge").with.path, "${{ runner.temp }}/evaluation-output/");
  assert.equal(step("upload_badge").with.name, "evaluation-output");
  assert.equal(step("upload_badge").with["if-no-files-found"], "error");
  assert.ok(steps.indexOf(generator) < steps.indexOf(step("upload_badge")));
  assert.ok(!steps.some((entry) => /publish|commit/i.test(entry.name)));
  assert.equal(steps.find((entry) => entry.name === "Summary").env.SOURCE_SHA, "${{ github.sha }}");
  for (const entry of steps.filter((entry) => entry.run)) {
    assert.doesNotMatch(entry.run, /git\s+(?:push|commit)|evaluation-results|publish_badge/);
    const syntax = spawnSync("bash", ["-n"], { input: entry.run, encoding: "utf8" });
    assert.equal(syntax.status, 0, `${entry.name}: ${syntax.stderr}`);
  }
});

test("the badge CLI creates an SVG in the fresh output directory without touching the tracked image", (context) => {
  const f = fixture(context);
  const input = join(f.directory, "results.jsonl");
  writeFileSync(input, `${JSON.stringify({
    fileName: ".github/agents/example.agent.md", score: 7, reasoning: "Fixture evaluation",
  })}\n`);
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "cli.ts", "badge", "--input", input,
    "--output", f.badge, "--date", `fixture-run ${f.main.slice(0, 12)}`,
  ], { cwd: join(repository, "evaluator"), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const svg = readFileSync(f.badge, "utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /7\/10/);
  assert.match(svg, /fixture-run/);
  assert.match(svg, new RegExp(f.main.slice(0, 12)));
  assert.match(svg, /<\/svg>$/);
  assert.equal(readFileSync(join(f.source, "eval-badge.svg"), "utf8"), "<svg>old tracked badge</svg>\n");
  assert.equal(f.published(), "");
});

test("generation uses fresh run output and failures cannot reuse the tracked root badge", (context) => {
  const f = fixture(context);
  const path = f.mockNpx();
  const failed = f.run(generator.run, { PATH: path, MOCK_EXIT: "1" }, join(f.source, "evaluator"));
  assert.notEqual(failed.status, 0);
  assert.ok(!existsSync(f.badge));
  assert.equal(f.published(), "");
  assert.equal(readFileSync(join(f.source, "eval-badge.svg"), "utf8"), "<svg>old tracked badge</svg>\n");
  const success = f.run(generator.run, { PATH: path }, join(f.source, "evaluator"));
  assert.equal(success.status, 0, success.stderr);
  assert.equal(readFileSync(f.badge, "utf8"), "<svg>generated fixture</svg>\n");
  assert.equal(f.published(), "");
  assert.equal(git(f.source, "rev-parse", "HEAD"), f.main);
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

test("result summaries do not turn empty or invalid output into a successful zero or NaN average", (context) => {
  const f = fixture(context);
  const summary = join(f.runnerTemp, "summary.md");
  const input = join(f.source, "evaluator", "eval_results.jsonl");
  const run = steps.find((entry) => entry.name === "Summary").run;
  const execute = () => f.run(run, { GITHUB_STEP_SUMMARY: summary }, join(f.source, "evaluator"));
  writeFileSync(input, "");
  assert.equal(execute().status, 0);
  assert.match(readFileSync(summary, "utf8"), /No new SVG can be published/);
  assert.doesNotMatch(readFileSync(summary, "utf8"), /NaN|Average/);
  writeFileSync(input, '{"fileName":"example.agent.md","score":0,"reasoning":"Invalid"}\n');
  assert.notEqual(execute().status, 0);
  writeFileSync(input, "not JSON\n");
  assert.notEqual(execute().status, 0);
  writeFileSync(input, '{"fileName":"example.agent.md","score":7,"reasoning":"Partial fixture"}\n');
  writeFileSync(summary, "");
  assert.equal(execute().status, 0);
  assert.match(readFileSync(summary, "utf8"), /may be partial; publication requires a complete evaluation/);
  assert.doesNotMatch(readFileSync(summary, "utf8"), /NaN/);
});

test("badge summaries display a direct SVG and identify complete, failed, and non-main evaluations", (context) => {
  const f = fixture(context);
  const summary = join(f.runnerTemp, "summary.md");
  const run = steps.find((entry) => entry.name === "Badge summary").run;
  const env = {
    GITHUB_STEP_SUMMARY: summary,
    SOURCE_SHA: f.main,
    RUN_URL: "https://github.com/example/project/actions/runs/1",
    UPLOAD_OUTCOME: "success",
    PATH: f.mockNpx(),
  };
  const preview = f.run(run, env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(readFileSync(summary, "utf8"), /Pages workflow publishes eligible main results after this run succeeds/);
  assert.match(readFileSync(summary, "utf8"), new RegExp(f.main));
  assert.match(readFileSync(summary, "utf8"), /!\[Latest complete main evaluation\]\(https:\/\/example.github.io\/project\/evaluation\/eval-badge.svg\)/);
  assert.doesNotMatch(readFileSync(summary, "utf8"), /#artifacts/);
  writeFileSync(summary, "");
  assert.equal(f.run(run, { ...env, UPLOAD_OUTCOME: "skipped" }).status, 0);
  assert.match(readFileSync(summary, "utf8"), /Evaluation was not published.*last complete main SVG is unchanged/);
  writeFileSync(summary, "");
  assert.equal(f.run(run, { ...env, SOURCE_REF: "refs/heads/feature" }).status, 0);
  assert.match(readFileSync(summary, "utf8"), /non-main runs do not update the public image/);
});

test("optional Pages URL failures cannot invalidate a complete evaluation or create a broken viewer link", (context) => {
  const f = fixture(context);
  const summary = join(f.runnerTemp, "summary.md");
  const run = steps.find((entry) => entry.name === "Badge summary").run;
  const env = {
    GITHUB_STEP_SUMMARY: summary, UPLOAD_OUTCOME: "success",
    RUN_URL: "https://github.com/example/project/actions/runs/1",
    PATH: f.mockNpx(),
  };
  for (const overrides of [{ MOCK_PAGES_EXIT: "1" }, { MOCK_PAGES_URL: "null" }]) {
    writeFileSync(summary, "");
    const result = f.run(run, { ...env, ...overrides });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::Pages viewer URL is unavailable/);
    const markdown = readFileSync(summary, "utf8");
    assert.match(markdown, /Complete evaluation/);
    assert.match(markdown, /Pages viewer unavailable/);
    assert.match(markdown, /complete bundle can be published without repeating AI evaluation/);
    assert.doesNotMatch(markdown, /!\[|View the SVG directly/);
  }
  writeFileSync(summary, "");
  assert.equal(f.run(run, { ...env, MOCK_PAGES_EXIT: "1", UPLOAD_OUTCOME: "skipped" }).status, 0);
  assert.match(readFileSync(summary, "utf8"), /Evaluation was not published/);
  assert.doesNotMatch(readFileSync(summary, "utf8"), /without repeating AI evaluation/);
});

test("main advancing at the former publication boundary cannot publish a stale shared badge", (context) => {
  const f = fixture(context);
  const path = f.mockNpx();
  const generated = f.run(generator.run, { PATH: path }, join(f.source, "evaluator"));
  assert.equal(generated.status, 0, generated.stderr);
  const svg = readFileSync(f.badge, "utf8");
  git(f.source, "commit", "--quiet", "--allow-empty", "-m", "Concurrent main advance");
  git(f.source, "push", "--quiet", "origin", "main");
  const nextMain = git(f.source, "rev-parse", "HEAD");
  const summary = join(f.runnerTemp, "summary.md");
  const result = f.run(steps.find((entry) => entry.name === "Badge summary").run, {
    GITHUB_STEP_SUMMARY: summary, UPLOAD_OUTCOME: "success",
    RUN_URL: "https://github.com/example/project/actions/runs/1",
    PATH: path,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(summary, "utf8"), new RegExp(f.main));
  assert.match(readFileSync(summary, "utf8"), /latest published complete main evaluation/);
  assert.equal(readFileSync(f.badge, "utf8"), svg);
  assert.equal(f.published(), "");
  assert.equal(git(f.source, "--git-dir", f.remote, "rev-parse", "main"), nextMain);
  assert.equal(readFileSync(join(f.source, "eval-badge.svg"), "utf8"), "<svg>old tracked badge</svg>\n");
});
