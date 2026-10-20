import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execute, lanePlan, lanes } from "./runner-lane.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (name) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");

test("old workflows and the old image action are unchanged", () => {
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
  for (const [file, expected] of Object.entries(baseline.sha256)) {
    assert.equal(createHash("sha256").update(read(file)).digest("hex"), expected, file);
  }
});

test("both lanes retain every top-level check:all command exactly once", () => {
  const scripts = JSON.parse(read("packages/paperclip-runner/package.json")).scripts;
  const actual = Object.keys(lanes).flatMap((lane) => lanePlan(lane).map((args) => args.at(-1)));
  assert.deepEqual(actual, scripts["check:all"].split(" && ").map((part) => part.replace("pnpm run ", "")));
  assert.equal(new Set(actual).size, actual.length);
  assert.throws(() => lanePlan("unrecognised"));
  assert.throws(() => lanePlan("protocol", { ...scripts, "check:all": scripts["check:all"] + " && pnpm run new-check" }));
  assert.throws(() => lanePlan("rust", { ...scripts, "check:runner": "cargo check" }));
});

test("failure or cancellation stops a lane before its next command", () => {
  for (const status of [9, null]) {
    const calls = [];
    assert.equal(execute("protocol", (exe, args) => { calls.push(args); return { status }; }), status ?? 1);
    assert.equal(calls.length, 1);
  }
  assert.throws(() => execute("rust", () => ({ error: new Error("missing pnpm") })), /missing pnpm/);
});

test("successful lane uses the repository root and inherits benchmark settings", () => {
  const calls = [];
  assert.equal(execute("rust", (exe, args, options) => {
    assert.equal(exe, "pnpm");
    assert.equal(options.cwd, root);
    assert.equal(options.env, process.env);
    calls.push(args.at(-1));
    return { status: 0 };
  }), 0);
  assert.deepEqual(calls, ["check:runner", "check:api-authority"]);
});

test("regression lots still cover all server suites without overlap", () => {
  for (const [group, count, field] of [["general-server", 8, "selectedGeneralServerSuites"], ["serialized", 5, "selectedSerializedSuites"]]) {
    function plan(index, total) {
      const args = ["scripts/run-vitest-stable.mjs", "--mode", group === "serialized" ? "serialized" : "general", "--shard-index", String(index), "--shard-count", String(total), "--dry-run"];
      if (group !== "serialized") args.push("--group", group);
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout)[field];
    }
    const full = plan(0, 1);
    const actual = Array.from({ length: count }, (_, i) => plan(i, count)).flat();
    assert.equal(new Set(actual).size, actual.length);
    assert.deepEqual(actual.sort(), full.sort());
  }
});

test("manual candidates use separate concurrency and preserve the combined verifier", () => {
  for (const file of ["ci-candidate.yml", "image-candidate.yml"]) {
    const source = read(`.github/workflows/${file}`);
    assert.match(source, /workflow_dispatch:/);
    const qualificationBranch = file === "ci-candidate.yml" ? "work/ci-performance-qualification-ci-20261020" : "work/ci-performance-qualification-image-20261020";
    const pushBlock = source.match(/\n  push:\n    branches:\n    - ([^\n]+)\n/);
    assert.equal(pushBlock?.[1], qualificationBranch);
    assert.doesNotMatch(source, /^\s*(pull_request|schedule|workflow_run):/m);
    assert.doesNotMatch(source, /packages: write|id-token: write|attestations: write|self-hosted/);
    assert.match(source, /group: (ci|image)-candidate-/);
  }
  const ci = read(".github/workflows/ci-candidate.yml");
  assert.match(ci, /verify-runner-log\.mjs/);
  assert.match(ci, /PAPERCLIP_FINAL_BURST_BENCHMARK: '1'/);
  assert.match(ci, /runner-protocol\.log/);
  assert.match(ci, /runner-rust\.log/);
  const image = read(".github/actions/agentfleet-image-candidate/action.yml");
  assert.match(image, /--load/);
  assert.match(image, /--cache-from "type=local/);
  assert.match(image, /--cache-to "type=local[^\n]+mode=max/);
  assert.doesNotMatch(image, /uses: docker\//);
  assert.match(image, /image-smoke\.sh/);
  assert.match(image, /sum\.golang\.org|go install/);
  assert.doesNotMatch(image, /docker push|docker login|gh attestation/);
});


test("candidate actions comply with the repository action allowlist", () => {
  for (const name of [".github/workflows/ci-candidate.yml", ".github/workflows/image-candidate.yml", ".github/actions/agentfleet-deps-candidate/action.yml", ".github/actions/agentfleet-image-candidate/action.yml"]) {
    for (const [, action] of read(name).matchAll(/uses: ([^\s]+)\s/g)) {
      assert.ok(action.startsWith("actions/") || action.startsWith("./"), `${name}: ${action}`);
    }
  }
});
