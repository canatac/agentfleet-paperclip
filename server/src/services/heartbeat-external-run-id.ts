import {
  HermesRunIdError,
  hermesGatewayType,
  normalizeHermesRunId,
} from "@paperclipai/hermes-paperclip-adapter";

// Link between a Paperclip run and the Hermes execution that served it
// (heartbeat_runs.external_run_id). Contract:
// docs/agentfleet/HERMES_RUN_LINK_CONTRACT.md (AF-OBS-001, AF-OBS-003).

export type ExternalRunIdError =
  | {
      code: "hermes_run_id_invalid";
      reason: string;
      message: string;
    }
  | {
      code: "external_run_id_conflict";
      message: string;
      existingExternalRunId: string;
      receivedExternalRunId: string;
    };

export type ExternalRunIdResolution =
  | { kind: "none" }
  | { kind: "set"; externalRunId: string }
  | { kind: "unchanged"; externalRunId: string }
  | { kind: "rejected"; error: ExternalRunIdError };

/**
 * Decides what the terminal write does with heartbeat_runs.external_run_id.
 * Only the hermes_gateway adapter reports a Hermes run id. The value is never
 * trimmed, never replaced by null, and never overwritten: a different value
 * already stored for the same run is kept and reported as a conflict.
 */
export function resolveTerminalExternalRunId(input: {
  adapterType: string | null | undefined;
  sessionParams: unknown;
  existingExternalRunId: string | null | undefined;
}): ExternalRunIdResolution {
  if (input.adapterType !== hermesGatewayType) return { kind: "none" };
  const params = input.sessionParams;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { kind: "none" };
  }

  let received: string | null;
  try {
    received = normalizeHermesRunId((params as Record<string, unknown>).hermesRunId);
  } catch (err) {
    if (err instanceof HermesRunIdError) {
      return {
        kind: "rejected",
        error: { code: err.code, reason: err.reason, message: err.message },
      };
    }
    throw err;
  }
  if (received === null) return { kind: "none" };

  const existing = input.existingExternalRunId ?? null;
  if (existing === null) return { kind: "set", externalRunId: received };
  if (existing === received) return { kind: "unchanged", externalRunId: received };
  return {
    kind: "rejected",
    error: {
      code: "external_run_id_conflict",
      message: "The run already has a different Hermes run id; the first one is kept.",
      existingExternalRunId: existing,
      receivedExternalRunId: received,
    },
  };
}
