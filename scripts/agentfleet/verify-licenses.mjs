#!/usr/bin/env node
// AgentFleet license check (AF-CI-001i, docs/agentfleet/CI.md).
//
// Lists the licenses of the installed production dependencies
// (`pnpm licenses list --prod --json`) and checks them against
// scripts/agentfleet/license-policy.json: every license must be allowed,
// or the package must be a reviewed exception (name, version and reported
// license). An exception that no longer matches an installed package fails
// the check, so the list stays exact.
//
//   node scripts/agentfleet/verify-licenses.mjs [--json <file>]
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const policy = JSON.parse(readFileSync(path.join(repoRoot, "scripts", "agentfleet", "license-policy.json"), "utf8"));
const allowed = new Set(policy.allowed.map((id) => id.toLowerCase()));

const jsonIndex = process.argv.indexOf("--json");
const jsonOutput = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;

// An SPDX expression without nesting: "A", "(A OR B)", "(A AND B)".
function isAllowed(expression) {
  const text = expression.trim().replace(/^\((.*)\)$/, "$1");
  return text.split(/\s+OR\s+/i).some((alternative) =>
    alternative.split(/\s+AND\s+/i).every((term) => allowed.has(term.trim().replace(/^\(|\)$/g, "").toLowerCase())));
}

const result = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
let inventory;
try {
  inventory = JSON.parse(result.stdout);
} catch {
  console.error(`[licenses] pnpm licenses produced no JSON report (exit ${result.status}):\n${result.stderr}`);
  process.exit(1);
}

const packages = Object.entries(inventory).flatMap(([license, entries]) =>
  entries.flatMap((entry) => (entry.versions ?? [""]).map((version) => ({ name: entry.name, version, license }))));
if (packages.length === 0) {
  console.error("[licenses] no production package listed");
  process.exit(1);
}

const matchedExceptions = new Set();
const violations = [];
for (const item of packages) {
  if (isAllowed(item.license)) continue;
  const index = policy.exceptions.findIndex((entry) =>
    entry.name === item.name && entry.version === item.version && entry.license === item.license);
  if (index >= 0) {
    matchedExceptions.add(index);
    continue;
  }
  violations.push(`${item.name}@${item.version}: license "${item.license}" is not allowed and has no reviewed exception`);
}
policy.exceptions.forEach((entry, index) => {
  if (!matchedExceptions.has(index)) {
    violations.push(`exception ${entry.name}@${entry.version} ("${entry.license}") matches no installed production package: review it again or remove it`);
  }
});

const counts = Object.fromEntries(
  Object.entries(inventory)
    .map(([license, entries]) => [license, entries.reduce((sum, entry) => sum + (entry.versions?.length ?? 1), 0)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);
console.log(`[licenses] ${packages.length} production packages, ${Object.keys(counts).length} license identifiers, ${matchedExceptions.size} reviewed exceptions`);
for (const [license, count] of Object.entries(counts)) console.log(`[licenses]   ${String(count).padStart(5)} ${license}`);
if (jsonOutput) writeFileSync(jsonOutput, `${JSON.stringify({ counts, violations }, null, 2)}\n`);

const target = process.env.GITHUB_STEP_SUMMARY;
if (target) {
  const lines = [
    "### Licenses of the production dependencies",
    "",
    `${packages.length} packages; ${matchedExceptions.size} reviewed exceptions; ${violations.length} violations.`,
    "",
    "| License | Packages |",
    "|---|---|",
    ...Object.entries(counts).map(([license, count]) => `| ${license.replaceAll("|", "\\|")} | ${count} |`),
    "",
  ];
  if (violations.length > 0) lines.push("Violations:", "", ...violations.map((violation) => `- ${violation}`), "");
  appendFileSync(target, `${lines.join("\n")}\n`);
}

if (violations.length > 0) {
  console.error(`[licenses] ${violations.length} violations:`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
