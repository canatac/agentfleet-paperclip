import { describe, expect, it } from "vitest";
import { resolveTerminalExternalRunId } from "../services/heartbeat-external-run-id.ts";

const hermes = "hermes_gateway";

describe("resolveTerminalExternalRunId", () => {
  it("records the Hermes run id of a hermes_gateway run", () => {
    expect(resolveTerminalExternalRunId({
      adapterType: hermes,
      sessionParams: { hermesRunId: "run-hermes-1", strategy: "task" },
      existingExternalRunId: null,
    })).toEqual({ kind: "set", externalRunId: "run-hermes-1" });
  });

  it("keeps the identifier byte for byte", () => {
    expect(resolveTerminalExternalRunId({
      adapterType: hermes,
      sessionParams: { hermesRunId: " run-hermes-1 " },
      existingExternalRunId: undefined,
    })).toEqual({ kind: "set", externalRunId: " run-hermes-1 " });
  });

  it("ignores other adapters, even with a hermesRunId key", () => {
    expect(resolveTerminalExternalRunId({
      adapterType: "codex_local",
      sessionParams: { hermesRunId: "run-hermes-1" },
      existingExternalRunId: null,
    })).toEqual({ kind: "none" });
    expect(resolveTerminalExternalRunId({
      adapterType: "hermes_local",
      sessionParams: { hermesRunId: "run-hermes-1" },
      existingExternalRunId: null,
    })).toEqual({ kind: "none" });
  });

  it("writes nothing when no Hermes run was created", () => {
    for (const sessionParams of [undefined, null, {}, { hermesRunId: null }, ["run-hermes-1"], "run-hermes-1"]) {
      expect(resolveTerminalExternalRunId({
        adapterType: hermes,
        sessionParams,
        existingExternalRunId: null,
      })).toEqual({ kind: "none" });
    }
  });

  it("never replaces a stored value with null", () => {
    expect(resolveTerminalExternalRunId({
      adapterType: hermes,
      sessionParams: { strategy: "task" },
      existingExternalRunId: "run-hermes-1",
    })).toEqual({ kind: "none" });
  });

  it("is idempotent for the same value", () => {
    expect(resolveTerminalExternalRunId({
      adapterType: hermes,
      sessionParams: { hermesRunId: "run-hermes-1" },
      existingExternalRunId: "run-hermes-1",
    })).toEqual({ kind: "unchanged", externalRunId: "run-hermes-1" });
  });

  it("keeps the first value and reports a conflict", () => {
    expect(resolveTerminalExternalRunId({
      adapterType: hermes,
      sessionParams: { hermesRunId: "run-hermes-2" },
      existingExternalRunId: "run-hermes-1",
    })).toEqual({
      kind: "rejected",
      error: {
        code: "external_run_id_conflict",
        message: "The run already has a different Hermes run id; the first one is kept.",
        existingExternalRunId: "run-hermes-1",
        receivedExternalRunId: "run-hermes-2",
      },
    });
  });

  it("rejects a malformed identifier without writing it", () => {
    const cases: Array<[unknown, string]> = [
      [42, "not_a_string"],
      ["", "blank"],
      ["   ", "blank"],
      ["a".repeat(257), "too_long"],
      ["run\nhermes", "control_character"],
      ["run-\ud800", "malformed_unicode"],
    ];
    for (const [hermesRunId, reason] of cases) {
      const resolution = resolveTerminalExternalRunId({
        adapterType: hermes,
        sessionParams: { hermesRunId },
        existingExternalRunId: null,
      });
      expect(resolution).toMatchObject({
        kind: "rejected",
        error: { code: "hermes_run_id_invalid", reason },
      });
    }
  });
});
