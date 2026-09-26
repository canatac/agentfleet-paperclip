#!/usr/bin/env node
// AgentFleet regression lot (AF-CI-001d, docs/agentfleet/CI.md).
//
// Runs one lot of the upstream regression suites. The suites of a lot are the
// ones the unchanged upstream runner selects (scripts/run-vitest-stable.mjs
// --dry-run), and each Vitest invocation uses the same arguments and the same
// isolated PAPERCLIP_HOME and TMPDIR as that runner, plus a JSON report. The
// lot then fails on any failed test or suite, and on any skipped or todo test
// that scripts/agentfleet/regression-policy.json does not allow. Files that
// the policy excludes are not run.
//
//   node scripts/agentfleet/run-regression.mjs --lot <lot> --report-dir <dir>
//   node scripts/agentfleet/run-regression.mjs --lot <lot> --plan
//
// --plan prints the Vitest invocations of the lot as JSON and runs nothing.
//
// Lots (the CI matrix): general-server:<i>/<n>, general-workspaces-a:<i>/<n>,
// general-workspaces-b and serialized:<i>/<n>, with i from 1 to n.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const policyPath = path.join(repoRoot, "scripts", "agentfleet", "regression-policy.json");
const upstreamRunner = "scripts/run-vitest-stable.mjs";

// Mirrors of scripts/run-vitest-stable.mjs. The runner's hash is pinned below:
// when a resync changes the runner, the lot fails until this file is reviewed
// against it and the hash is updated.
const upstreamRunnerSha256 = "2925ff8451471efb30d160b902b254bebbf30bb8bf9503e3b15105e67f9e0029";
const upstreamTestScripts = {
  "test:run:general":
    "pnpm run preflight:workspace-links && pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && node scripts/run-vitest-stable.mjs --mode general",
  "test:run:serialized":
    "pnpm run preflight:workspace-links && pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && node scripts/run-vitest-stable.mjs --mode serialized",
};
const sourceOnlyVitestArgs = ["--exclude", "**/dist/**"];
const serializedServerVitestArgs = ["--no-file-parallelism", "--maxWorkers=1"];
const serverProject = "@paperclipai/server";

function fail(message) {
  console.error(`[regression] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { lot: null, reportDir: null, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") {
      options.plan = true;
      continue;
    }
    if (arg === "--lot" || arg === "--report-dir") {
      const value = argv[index + 1];
      if (value === undefined) fail(`Missing value for ${arg}.`);
      options[arg === "--lot" ? "lot" : "reportDir"] = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument "${arg}".`);
  }
  if (!options.lot || (!options.reportDir && !options.plan)) fail("Usage: run-regression.mjs --lot <lot> (--report-dir <dir> | --plan)");
  return options;
}

function parseLot(value) {
  const match = /^(general-server|general-workspaces-a|general-workspaces-b|serialized)(?::([1-9][0-9]*)\/([1-9][0-9]*))?$/.exec(value);
  if (!match) fail(`Unknown lot "${value}".`);
  const [, group, index, count] = match;
  const sharded = index !== undefined;
  if (sharded && Number(index) > Number(count)) fail(`Lot "${value}": shard ${index} of ${count}.`);
  if (group === "general-workspaces-b" && sharded) fail("general-workspaces-b is not sharded upstream.");
  if (group !== "general-workspaces-b" && !sharded) fail(`Lot "${value}" needs a shard, for example ${group}:1/1.`);
  return {
    group,
    shardIndex: sharded ? Number(index) - 1 : null,
    shardCount: sharded ? Number(count) : null,
  };
}

function checkUpstreamRunner() {
  const source = readFileSync(path.join(repoRoot, upstreamRunner));
  const actual = createHash("sha256").update(source).digest("hex");
  if (actual !== upstreamRunnerSha256) {
    fail(`${upstreamRunner} changed (sha256 ${actual}). Review scripts/agentfleet/run-regression.mjs against it, then update upstreamRunnerSha256.`);
  }
  const scripts = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).scripts ?? {};
  for (const [name, expected] of Object.entries(upstreamTestScripts)) {
    if (scripts[name] !== expected) {
      fail(`package.json script "${name}" changed. Review scripts/agentfleet/run-regression.mjs against it.`);
    }
  }
}

function loadPolicy() {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const excludedFiles = policy.excludedFiles ?? [];
  const allowedSkips = policy.allowedSkips ?? [];
  for (const entry of excludedFiles) {
    if (!entry.file || !entry.reason || !entry.decision) fail(`Excluded file entry without file, reason or decision: ${JSON.stringify(entry)}`);
    // Only server files are handled: they are passed to Vitest as file lists.
    if (!entry.file.startsWith("server/")) fail(`Excluded file outside server/ is not supported: ${entry.file}`);
    if (!existsSync(path.join(repoRoot, entry.file))) fail(`Excluded file no longer exists upstream, update the policy: ${entry.file}`);
  }
  for (const entry of allowedSkips) {
    if (!entry.file || !entry.reason || !entry.decision) fail(`Allowed skip entry without file, reason or decision: ${JSON.stringify(entry)}`);
    // Either one exact test, or every test of one file under a name prefix
    // with the exact number expected.
    const exact = typeof entry.fullName === "string" && entry.fullNamePrefix === undefined && entry.count === undefined;
    const prefixed = typeof entry.fullNamePrefix === "string" && Number.isInteger(entry.count) && entry.count > 0 && entry.fullName === undefined;
    if (!exact && !prefixed) fail(`Allowed skip entry needs fullName, or fullNamePrefix with count: ${JSON.stringify(entry)}`);
  }
  return { excludedFiles: new Set(excludedFiles.map((entry) => entry.file)), allowedSkips };
}

function upstreamPlan(lot) {
  const shardArgs = lot.shardCount === null ? [] : ["--shard-index", String(lot.shardIndex), "--shard-count", String(lot.shardCount)];
  const modeArgs = lot.group === "serialized" ? ["--mode", "serialized"] : ["--mode", "general", "--group", lot.group];
  const result = spawnSync(process.execPath, [upstreamRunner, ...modeArgs, ...shardArgs, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    fail(`${upstreamRunner} --dry-run failed: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function planInvocations(lot, plan, excludedFiles) {
  const excluded = [];
  const keep = (file) => {
    if (excludedFiles.has(file)) {
      excluded.push(file);
      return false;
    }
    return true;
  };
  let invocations;
  if (lot.group === "serialized") {
    invocations = plan.selectedSerializedSuites
      .filter(keep)
      .map((file) => ({ label: file, args: ["--project", serverProject, file, "--pool=forks", "--isolate"] }));
  } else if (lot.group === "general-server") {
    const files = plan.selectedGeneralServerSuites.filter(keep);
    invocations = files.length === 0
      ? []
      : [{ label: `general-server shard ${lot.shardIndex + 1}/${lot.shardCount} (${files.length} suites)`, args: ["--project", serverProject, ...serializedServerVitestArgs, ...files] }];
  } else {
    const shardArgs = plan.workspacesVitestShard ? [`--shard=${plan.workspacesVitestShard}`] : [];
    invocations = plan.workspaceProjects.map((project) => ({ label: `${lot.group} project ${project}`, args: ["--project", project, ...shardArgs] }));
  }
  return { invocations, excluded };
}

function runPnpm(args) {
  const result = spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error || result.status !== 0) fail(`pnpm ${args.join(" ")} failed.`);
}

let invocationIndex = 0;
function runVitest(args, reportFile) {
  invocationIndex += 1;
  const testRoot = realpathSync(mkdtempSync(path.join("/tmp", "pv-")));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    PAPERCLIP_CONFIG: path.join(testRoot, "h", "config.json"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "t"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", ...sourceOnlyVitestArgs, ...args, "--reporter=default", "--reporter=json", `--outputFile=${reportFile}`],
    { cwd: repoRoot, env, stdio: "inherit" },
  );
  return result.error ? `could not start Vitest: ${result.error.message}` : result.status;
}

function matchAllowedSkip(allowedSkips, file, fullName) {
  return allowedSkips.findIndex((entry) =>
    entry.file === file &&
    (entry.fullName !== undefined ? entry.fullName === fullName : fullName.startsWith(entry.fullNamePrefix)));
}

function checkReports(results, allowedSkips) {
  const matches = allowedSkips.map(() => 0);
  const ranFiles = new Set();
  const totals = { files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  const problems = [];
  const skips = [];
  for (const { label, status, reportFile } of results) {
    if (status !== 0) problems.push(`${label}: Vitest exited with ${status}`);
    if (!existsSync(reportFile)) {
      problems.push(`${label}: no JSON report`);
      continue;
    }
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    totals.files += report.testResults.length;
    totals.tests += report.numTotalTests;
    totals.passed += report.numPassedTests;
    totals.failed += report.numFailedTests;
    totals.skipped += report.numPendingTests;
    totals.todo += report.numTodoTests;
    for (const file of report.testResults) {
      const repoPath = path.relative(repoRoot, file.name).split(path.sep).join("/");
      ranFiles.add(repoPath);
      if (file.status === "failed" && file.message) problems.push(`${repoPath}: ${file.message.split("\n")[0]}`);
      for (const test of file.assertionResults) {
        if (test.status === "passed") continue;
        if (test.status === "failed") {
          problems.push(`${repoPath}: failed: ${test.fullName}`);
          continue;
        }
        const index = matchAllowedSkip(allowedSkips, repoPath, test.fullName);
        if (index >= 0) matches[index] += 1;
        skips.push({ file: repoPath, fullName: test.fullName, status: test.status, allowed: index >= 0 });
        if (index < 0) problems.push(`${repoPath}: ${test.status} without an approved exception: ${test.fullName}`);
      }
    }
  }
  // The exceptions stay exact: one whose file ran in this lot must match
  // exactly (a test that runs again, or a new skipped test under a prefix,
  // fails the lot until the policy is reviewed).
  allowedSkips.forEach((entry, index) => {
    if (!ranFiles.has(entry.file)) return;
    const expected = entry.count ?? 1;
    if (matches[index] !== expected) {
      problems.push(`${entry.file}: approved exception matched ${matches[index]} skipped tests, expected ${expected}: ${entry.fullName ?? `${entry.fullNamePrefix}*`}`);
    }
  });
  if (totals.tests === 0) problems.push("no test ran");
  return { totals, problems, skips };
}

function writeSummary(lotName, excluded, invocations, outcome, summaryFile) {
  writeFileSync(summaryFile, `${JSON.stringify({ lot: lotName, excluded, invocations: invocations.length, ...outcome }, null, 2)}\n`);
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  const { totals, problems, skips } = outcome;
  const lines = [
    `### Regression lot \`${lotName}\``,
    "",
    `Vitest invocations: ${invocations.length}; files: ${totals.files}; tests: ${totals.tests}; passed: ${totals.passed}; failed: ${totals.failed}; skipped: ${totals.skipped}; todo: ${totals.todo}.`,
    "",
  ];
  if (excluded.length > 0) lines.push(`Excluded by the policy: ${excluded.map((file) => `\`${file}\``).join(", ")}.`, "");
  if (skips.length > 0) {
    lines.push("| File | Test | Status | Approved exception |", "|---|---|---|---|");
    for (const skip of skips.slice(0, 300)) {
      lines.push(`| \`${skip.file}\` | ${skip.fullName.replaceAll("|", "\\|")} | ${skip.status} | ${skip.allowed ? "yes" : "no"} |`);
    }
    if (skips.length > 300) lines.push(`| … | ${skips.length - 300} more in the JSON summary | | |`);
    lines.push("");
  }
  lines.push(problems.length === 0 ? "Result: pass." : `Result: fail (${problems.length} problems).`, "");
  appendFileSync(target, `${lines.join("\n")}\n`);
}

const options = parseArgs(process.argv.slice(2));
const lot = parseLot(options.lot);
checkUpstreamRunner();
const policy = loadPolicy();
const plan = upstreamPlan(lot);
const { invocations, excluded } = planInvocations(lot, plan, policy.excludedFiles);
if (invocations.length === 0) fail(`Lot "${options.lot}" selects no suite.`);
if (options.plan) {
  console.log(JSON.stringify({ lot: options.lot, excluded, invocations }, null, 2));
  process.exit(0);
}

const reportDir = path.resolve(options.reportDir);
mkdirSync(reportDir, { recursive: true });
const lotSlug = options.lot.replace(/[:/]/g, "-");

// The prelude of pnpm test:run:general and test:run:serialized.
runPnpm(["run", "preflight:workspace-links"]);
runPnpm(["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"]);

console.log(`[regression] lot ${options.lot}: ${invocations.length} Vitest invocations${excluded.length > 0 ? `, excluded: ${excluded.join(", ")}` : ""}`);
const results = invocations.map((invocation, index) => {
  const reportFile = path.join(reportDir, `${lotSlug}-${String(index + 1).padStart(3, "0")}.json`);
  console.log(`\n[regression] ${invocation.label}`);
  return { label: invocation.label, status: runVitest(invocation.args, reportFile), reportFile };
});

const outcome = checkReports(results, policy.allowedSkips);
writeSummary(options.lot, excluded, invocations, outcome, path.join(reportDir, `${lotSlug}-summary.json`));
const { totals, problems } = outcome;
console.log(`\n[regression] lot ${options.lot}: ${JSON.stringify(totals)}`);
if (problems.length > 0) {
  console.error(`[regression] ${problems.length} problems:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
