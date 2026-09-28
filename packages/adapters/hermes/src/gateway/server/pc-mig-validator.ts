/**
 * PC-MIG Validator — Level B
 * Validates the terminal text against the PC-MIG contract.
 * Does NOT infer provider/model from text — uses runtime metadata only.
 */

export interface PcMiGResult {
  protocol: string;
  provider: string;
  model: string;
  nonce: string;
  status: string;
}

export interface PcMiGValidationDecision {
  verdict: "ACCEPTED" | "REJECTED" | "INVALID_RESULT_JSON" | "NONCE_MISMATCH" | "RESULT_SCHEMA_MISMATCH" | "PROVIDER_ROUTE_MISMATCH" | "MODEL_ROUTE_MISMATCH" | "RUNTIME_METADATA_MISSING";
  result?: PcMiGResult;
  reason?: string;
  providerRuntime?: string;
  modelRuntime?: string;
}

const REQUIRED_KEYS = ["protocol", "provider", "model", "nonce", "status"] as const;
const ALLOWED_KEYS = new Set<string>(["protocol", "provider", "model", "nonce", "status", "issue", "agent"]);

export function validatePcMiGResult(
  terminalOutput: string,
  expectedNonce: string,
  runtimeProvider: string | undefined,
  runtimeModel: string | undefined,
): PcMiGValidationDecision {
  // V08: Runtime metadata must be present
  if (!runtimeProvider || !runtimeModel) {
    return { verdict: "RUNTIME_METADATA_MISSING", reason: "Runtime provider/model metadata is missing" };
  }

  // V06: Provider must be "nous" (from runtime metadata, not text)
  if (runtimeProvider !== "nous") {
    return { verdict: "PROVIDER_ROUTE_MISMATCH", reason: `Runtime provider is '${runtimeProvider}', expected 'nous'`, providerRuntime: runtimeProvider, modelRuntime: runtimeModel };
  }

  // V07: Model must be "meituan/longcat-2.0:free" (from runtime metadata)
  if (runtimeModel !== "meituan/longcat-2.0:free") {
    return { verdict: "MODEL_ROUTE_MISMATCH", reason: `Runtime model is '${runtimeModel}', expected 'meituan/longcat-2.0:free'`, providerRuntime: runtimeProvider, modelRuntime: runtimeModel };
  }

  // V02: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(terminalOutput);
  } catch {
    return { verdict: "INVALID_RESULT_JSON", reason: "Terminal output is not valid JSON", providerRuntime: runtimeProvider, modelRuntime: runtimeModel };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { verdict: "INVALID_RESULT_JSON", reason: "Parsed JSON is not an object", providerRuntime: runtimeProvider, modelRuntime: runtimeModel };
  }

  const obj = parsed as Record<string, unknown>;

  // V04: Required keys
  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      return { verdict: "RESULT_SCHEMA_MISMATCH", reason: `Missing required key: '${key}'`, providerRuntime: runtimeProvider, modelRuntime: runtimeModel };
    }
  }

  // V05: No extra keys beyond allowed
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { verdict: "RESULT_SCHEMA_MISMATCH", reason: `Unexpected key: '${key}'`, providerRuntime: runtimeProvider, modelRuntime: runtimeModel };
    }
  }

  // V03: Nonce match
  if (obj.nonce !== expectedNonce) {
    return { verdict: "NONCE_MISMATCH", reason: `Nonce mismatch: expected '${expectedNonce}', got '${obj.nonce}'`, providerRuntime: runtimeProvider, modelRuntime: runtimeModel };
  }

  return {
    verdict: "ACCEPTED",
    result: {
      protocol: String(obj.protocol),
      provider: String(obj.provider),
      model: String(obj.model),
      nonce: String(obj.nonce),
      status: String(obj.status),
    },
    providerRuntime: runtimeProvider,
    modelRuntime: runtimeModel,
  };
}
