#!/usr/bin/env node
// AgentFleet check of the Paperclip Runner verification log (AF-CI-001f,
// docs/agentfleet/CI.md).
//
// `pnpm --filter @paperclipai/paperclip-runner check:all` fails on a failed
// test but not on a skipped one. This script reads its log and fails on any
// skipped, todo or cancelled Vitest or node:test test, and on any ignored
// Rust test other than the subprocess helpers below, which their parent tests
// run in a child process: each of them must appear once as ignored and once
// as passed.
//
//   node scripts/agentfleet/verify-runner-log.mjs <check-all.log>
import { readFileSync } from "node:fs";

// #[ignore] entry points of packages/paperclip-runner/runner/crates/runner-core/tests/codex_provider.rs,
// re-run by their parent test with `--ignored --exact`.
const subprocessHelpers = [
  "provider_receives_isolated_codex_auth_home_subprocess",
  "failed_provider_startup_new_process_subprocess",
];

const logFile = process.argv[2];
if (!logFile) {
  console.error("Usage: verify-runner-log.mjs <check-all.log>");
  process.exit(2);
}

const lines = readFileSync(logFile, "utf8")
  .replace(/\x1b\[[0-9;]*m/g, "")
  .split("\n");
const problems = [];
const found = { vitest: 0, nodeTest: 0, cargo: 0 };
const cargoIgnored = { total: 0, names: [], passed: new Set() };

for (const line of lines) {
  // Vitest summary: "      Tests  2016 passed | 3 skipped (2019)".
  const vitest = /^\s*(Test Files|Tests)\s{2,}(.+)\(\d+\)\s*$/.exec(line);
  if (vitest) {
    if (vitest[1] === "Tests") found.vitest += 1;
    for (const [, count, status] of vitest[2].matchAll(/(\d+) (failed|skipped|todo)/g)) {
      if (Number(count) > 0) problems.push(`Vitest ${vitest[1].toLowerCase()}: ${count} ${status}`);
    }
    continue;
  }
  // node:test summary: "ℹ skipped 0".
  const nodeTest = /^ℹ (tests|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
  if (nodeTest) {
    if (nodeTest[1] === "tests") found.nodeTest += 1;
    else if (Number(nodeTest[2]) > 0) problems.push(`node:test: ${nodeTest[2]} ${nodeTest[1]}`);
    continue;
  }
  // cargo test: "test result: ok. 84 passed; 0 failed; 2 ignored; ...".
  const cargo = /^test result: \w+\. \d+ passed; (\d+) failed; (\d+) ignored;/.exec(line);
  if (cargo) {
    found.cargo += 1;
    if (Number(cargo[1]) > 0) problems.push(`cargo test: ${cargo[1]} failed`);
    cargoIgnored.total += Number(cargo[2]);
    continue;
  }
  const test = /^test (\S+) \.\.\. (ok|ignored)/.exec(line);
  if (test?.[2] === "ignored") cargoIgnored.names.push(test[1]);
  if (test?.[2] === "ok") cargoIgnored.passed.add(test[1]);
}

for (const [runner, count] of Object.entries(found)) {
  if (count === 0) problems.push(`no ${runner} summary in the log: the check:all output format changed, review this script`);
}
if (cargoIgnored.names.length !== cargoIgnored.total) {
  problems.push(`cargo test: ${cargoIgnored.total} ignored, but ${cargoIgnored.names.length} ignored test lines`);
}
for (const name of cargoIgnored.names) {
  if (!subprocessHelpers.includes(name)) problems.push(`cargo test: ignored without an approved reason: ${name}`);
}
for (const name of subprocessHelpers) {
  const ignored = cargoIgnored.names.filter((entry) => entry === name).length;
  if (ignored !== 1) problems.push(`cargo test: subprocess helper ${name} listed ${ignored} times as ignored, expected 1`);
  if (!cargoIgnored.passed.has(name)) problems.push(`cargo test: subprocess helper ${name} never ran in its child process`);
}

console.log(
  `[runner] summaries: ${found.vitest} Vitest, ${found.nodeTest} node:test, ${found.cargo} cargo; ` +
    `cargo ignored: ${cargoIgnored.total} (subprocess helpers run by their parent tests)`,
);
if (problems.length > 0) {
  console.error(`[runner] ${problems.length} problems:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
