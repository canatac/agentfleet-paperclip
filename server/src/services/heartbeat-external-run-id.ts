import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
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

export type LateExternalRunIdWrite =
  | { outcome: "written" }
  | { outcome: "unchanged" }
  | { outcome: "conflict"; existingExternalRunId: string }
  | { outcome: "missing" };

/**
 * Records the Hermes run id of a run that another path already finished (for
 * example a stop during the Hermes execution), when the adapter's terminal
 * write was skipped. Writes external_run_id only, and only while it is null:
 * the status, the result and every other column stay as the winning path left
 * them. Repeating the write with the same value changes nothing.
 */
export async function recordExternalRunIdIfUnset(
  db: Db,
  runId: string,
  externalRunId: string,
): Promise<LateExternalRunIdWrite> {
  const written = await db
    .update(heartbeatRuns)
    .set({ externalRunId })
    .where(and(eq(heartbeatRuns.id, runId), isNull(heartbeatRuns.externalRunId)))
    .returning({ id: heartbeatRuns.id })
    .then((rows) => rows[0] ?? null);
  if (written) return { outcome: "written" };

  const current = await db
    .select({ externalRunId: heartbeatRuns.externalRunId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!current) return { outcome: "missing" };
  if (current.externalRunId === externalRunId) return { outcome: "unchanged" };
  return { outcome: "conflict", existingExternalRunId: current.externalRunId ?? "" };
}
