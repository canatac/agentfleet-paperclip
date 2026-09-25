import { describe, expect, it } from "vitest";
import { HERMES_RUN_ID_MAX_BYTES, HermesRunIdError, normalizeHermesRunId } from "./run-id.js";

function reasonOf(value: unknown): string | null {
  try {
    normalizeHermesRunId(value);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(HermesRunIdError);
    expect(err).toBeInstanceOf(Error);
    expect((err as HermesRunIdError).code).toBe("hermes_run_id_invalid");
    return (err as HermesRunIdError).reason;
  }
}

describe("normalizeHermesRunId", () => {
  it("returns null when the identifier is absent", () => {
    expect(normalizeHermesRunId(undefined)).toBeNull();
    expect(normalizeHermesRunId(null)).toBeNull();
  });

  it("rejects a value that is not a string", () => {
    for (const value of [42, 0, true, false, {}, { id: "run-1" }, ["run-1"], Symbol("run")]) {
      expect(reasonOf(value)).toBe("not_a_string");
    }
  });

  it("rejects an empty or whitespace-only string", () => {
    for (const value of ["", " ", "   ", " 　", "﻿"]) {
      expect(reasonOf(value)).toBe("blank");
    }
  });

  it("accepts 256 UTF-8 bytes and rejects 257", () => {
    const ascii256 = "a".repeat(HERMES_RUN_ID_MAX_BYTES);
    expect(normalizeHermesRunId(ascii256)).toBe(ascii256);
    expect(reasonOf(`${ascii256}a`)).toBe("too_long");

    // Two bytes per character: the limit counts bytes, not characters.
    const twoByte256 = "é".repeat(128);
    expect(Buffer.byteLength(twoByte256, "utf8")).toBe(256);
    expect(normalizeHermesRunId(twoByte256)).toBe(twoByte256);
    expect(reasonOf(`${twoByte256}a`)).toBe("too_long");

    const threeByte255 = "€".repeat(85);
    expect(normalizeHermesRunId(`${threeByte255}a`)).toBe(`${threeByte255}a`);
    expect(reasonOf(`${threeByte255}ab`)).toBe("too_long");
  });

  it("rejects control characters", () => {
    for (const value of ["run\u0000id", "run\nid", "run\tid", "run\u001bid", "run\u007fid", "run\u0085id", "run\u009fid"]) {
      expect(reasonOf(value)).toBe("control_character");
    }
  });

  it("rejects lone surrogates, which cannot be stored byte for byte", () => {
    expect(reasonOf("run-\ud800")).toBe("malformed_unicode");
    expect(reasonOf("\udc00-run")).toBe("malformed_unicode");
    expect(normalizeHermesRunId("run-🚀")).toBe("run-🚀");
  });

  it("accepts UUID and non-UUID identifiers unchanged", () => {
    for (const value of [
      "0f8b6c1e-4b2d-4c55-9a51-2f7a3e9d6b10",
      "run_2026-09-25T14:00:00Z.abc",
      "run-hermes-1",
      "RUN:Ünïcödé/42",
    ]) {
      expect(normalizeHermesRunId(value)).toBe(value);
    }
  });

  it("never trims a valid identifier", () => {
    expect(normalizeHermesRunId(" run-1 ")).toBe(" run-1 ");
    expect(normalizeHermesRunId("run-1 ")).toBe("run-1 ");
    expect(normalizeHermesRunId(" run-1")).toBe(" run-1");
  });

  it("never substitutes another identifier", () => {
    const value = "hermes-run-7";
    const result = normalizeHermesRunId(value);
    expect(result).toBe(value);
    expect(Buffer.from(result ?? "", "utf8").equals(Buffer.from(value, "utf8"))).toBe(true);
  });
});
