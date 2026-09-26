#!/usr/bin/env node
// AgentFleet dependency audit report (AF-CI-001h, docs/agentfleet/CI.md).
//
// Runs `pnpm audit --prod --json` on the lockfile and reports the known
// vulnerabilities of the production dependencies, by severity, with the
// high and critical ones in detail. The report does not fail on
// vulnerabilities (operator decision, paperclip-fleet#73): new ones are
// blocked by the dependency-review workflow on each pull request. It fails
// only when the audit itself cannot run.
//
//   node scripts/agentfleet/report-audit.mjs [--json <file>]
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const severities = ["critical", "high", "moderate", "low", "info"];

const jsonIndex = process.argv.indexOf("--json");
const jsonOutput = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;

// pnpm audit exits non-zero when it finds vulnerabilities; only a missing
// or unreadable report is an error.
const result = spawnSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
let audit;
try {
  audit = JSON.parse(result.stdout);
} catch {
  console.error(`[audit] pnpm audit produced no JSON report (exit ${result.status}):\n${result.stderr}`);
  process.exit(1);
}
if (!audit.metadata?.vulnerabilities) {
  console.error(`[audit] unexpected pnpm audit report: ${result.stdout.slice(0, 500)}`);
  process.exit(1);
}

const counts = audit.metadata.vulnerabilities;
const serious = Object.values(audit.advisories ?? {})
  .filter((advisory) => advisory.severity === "critical" || advisory.severity === "high")
  .map((advisory) => ({
    severity: advisory.severity,
    module: advisory.module_name,
    vulnerable: advisory.vulnerable_versions,
    patched: advisory.patched_versions,
    advisory: advisory.github_advisory_id ?? String(advisory.id),
    versions: [...new Set(advisory.findings.map((finding) => finding.version))].sort(),
    // pnpm reports the paths only when the dependencies are installed.
    path: advisory.findings.flatMap((finding) => finding.paths ?? [])[0] ?? "",
  }))
  .sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity) || a.module.localeCompare(b.module));

const summary = severities.map((severity) => `${severity}: ${counts[severity] ?? 0}`).join(", ");
console.log(`[audit] production dependencies: ${audit.metadata.dependencies}; vulnerabilities: ${summary}`);
for (const item of serious) {
  console.log(`[audit] ${item.severity} ${item.module}@${item.versions.join(",")} ${item.advisory} (patched ${item.patched})${item.path ? ` via ${item.path}` : ""}`);
}
if (jsonOutput) writeFileSync(jsonOutput, `${JSON.stringify({ counts, serious }, null, 2)}\n`);

const target = process.env.GITHUB_STEP_SUMMARY;
if (target) {
  const lines = [
    "### Dependency audit (production, report only)",
    "",
    `Dependencies: ${audit.metadata.dependencies}. Vulnerabilities: ${summary}.`,
    "",
  ];
  if (serious.length > 0) {
    lines.push("| Severity | Package | Installed | Advisory | Patched | Path |", "|---|---|---|---|---|---|");
    for (const item of serious) {
      lines.push(`| ${item.severity} | \`${item.module}\` | ${item.versions.join(", ")} | ${item.advisory} | \`${item.patched}\` | ${item.path ? `\`${item.path}\`` : "—"} |`);
    }
    lines.push("");
  }
  appendFileSync(target, `${lines.join("\n")}\n`);
}
