#!/usr/bin/env node
// Run every top-level check:all command, split across independent VMs.
// The original combined no-skips verifier remains the final gate.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = path.join(root, "packages/paperclip-runner/package.json");
const expected = {
  "check:all": "pnpm run check:eval-kernel && pnpm run check:protocol && pnpm run check:runner && pnpm run check:api-authority",
  "check:protocol": "pnpm run typecheck:typescript && pnpm run check:protocol-manifest && pnpm run test:typescript && pnpm run check:replay-goldens",
  "check:runner": "pnpm run typecheck:rust && pnpm run test:rust && pnpm run check:conformance-parity && pnpm run check:replay-parity",
};
export const lanes = {
  protocol: ["check:eval-kernel", "check:protocol"],
  rust: ["check:runner", "check:api-authority"],
};

export function lanePlan(lane, scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts) {
  if (!Object.hasOwn(lanes, lane)) throw new Error(`Unknown runner lane: ${lane}`);
  for (const [name, command] of Object.entries(expected)) {
    if (scripts[name] !== command) throw new Error(`Runner script ${name} changed; review the candidate split`);
  }
  return lanes[lane].map((name) => ["--filter", "@paperclipai/paperclip-runner", "run", name]);
}

export function execute(lane, run = spawnSync) {
  for (const args of lanePlan(lane)) {
    console.log(`CANDIDATE_RUNNER_COMMAND=${args.at(-1)}`);
    const result = run("pnpm", args, { cwd: root, stdio: "inherit", env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 4 || (process.argv[3] && process.argv[3] !== "--plan")) throw new Error("Usage: runner-lane.mjs <protocol|rust> [--plan]");
    if (process.argv[3] === "--plan") console.log(JSON.stringify(lanePlan(process.argv[2])));
    else process.exitCode = execute(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
