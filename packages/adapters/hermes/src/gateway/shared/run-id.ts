// Validation of the Hermes run identifier that links a Paperclip run to its
// Hermes execution (heartbeat_runs.external_run_id). Contract:
// docs/agentfleet/HERMES_RUN_LINK_CONTRACT.md (AF-OBS-001).

export const HERMES_RUN_ID_MAX_BYTES = 256;

export type HermesRunIdErrorReason =
  | "not_a_string"
  | "blank"
  | "too_long"
  | "control_character"
  | "malformed_unicode";

export class HermesRunIdError extends Error {
  readonly code = "hermes_run_id_invalid";

  constructor(
    readonly reason: HermesRunIdErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "HermesRunIdError";
  }
}

// Unicode category Cc: C0 controls, DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
// A lone surrogate cannot be encoded in UTF-8, so it could not be stored byte for byte.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Returns the Hermes run identifier unchanged, or null when it is absent.
 * Throws HermesRunIdError when a value is present but malformed: a malformed
 * identifier is a protocol violation, kept distinct from an absent one.
 * A valid value is never trimmed or otherwise rewritten.
 */
export function normalizeHermesRunId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HermesRunIdError("not_a_string", `Hermes run id must be a string, got ${describeType(value)}.`);
  }
  if (value.trim().length === 0) {
    throw new HermesRunIdError("blank", "Hermes run id is empty or contains only whitespace.");
  }
  if (LONE_SURROGATE.test(value)) {
    throw new HermesRunIdError("malformed_unicode", "Hermes run id is not well-formed Unicode.");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > HERMES_RUN_ID_MAX_BYTES) {
    throw new HermesRunIdError(
      "too_long",
      `Hermes run id is ${bytes} bytes long; the limit is ${HERMES_RUN_ID_MAX_BYTES} bytes.`,
    );
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new HermesRunIdError("control_character", "Hermes run id contains a control character.");
  }
  return value;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  return typeof value;
}
