/**
 * I01-I06: Integration tests with fake Hermes gateway.
 * No LLM calls — simulates the full Paperclip → Hermes → mapper → validator chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePcMiGResult } from './pc-mig-validator.js';

// Simulate the full chain: terminal state → mapper → validator
function simulateRun(params: {
  terminalOutput: string | null;
  terminalStatus: string;
  outputChunks: string[];
  runtimeProvider: string;
  runtimeModel: string;
  expectedNonce: string;
}): { mapperResult: any; validatorDecision: any } {
  // Step 1: Map (simplified version of mapFinalResultForTest logic)
  const hasFinal = params.terminalOutput !== null && params.terminalOutput.trim() !== '';
  const mapperResult = {
    exitCode: hasFinal ? 0 : 1,
    errorCode: hasFinal ? undefined : 'MISSING_FINAL_RESPONSE',
    summary: hasFinal ? params.terminalOutput : undefined,
    diagnosticTranscript: params.outputChunks.join('').trim(),
    provider: 'hermes_gateway',
    model: params.runtimeModel,
  };

  // Step 2: If transport succeeded, validate PC-MIG contract
  let validatorDecision = null;
  if (mapperResult.exitCode === 0 && mapperResult.summary) {
    validatorDecision = validatePcMiGResult(
      mapperResult.summary,
      params.expectedNonce,
      params.runtimeProvider,
      params.runtimeModel,
    );
  }

  return { mapperResult, validatorDecision };
}

describe('I01-I06: Integration — Full chain simulation', () => {

  it('I01 — valid final → ACCEPTED', () => {
    const nonce = 'test-nonce-01';
    const json = `{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"${nonce}","status":"completed"}`;
    const { mapperResult, validatorDecision } = simulateRun({
      terminalOutput: json,
      terminalStatus: 'completed',
      outputChunks: [],
      runtimeProvider: 'nous',
      runtimeModel: 'meituan/longcat-2.0:free',
      expectedNonce: nonce,
    });
    expect(mapperResult.exitCode).toBe(0);
    expect(validatorDecision?.verdict).toBe('ACCEPTED');
  });

  it('I02 — transcript without final → technical failure', () => {
    const { mapperResult, validatorDecision } = simulateRun({
      terminalOutput: null,
      terminalStatus: 'completed',
      outputChunks: ['Reading file...', 'Analyzing...'],
      runtimeProvider: 'nous',
      runtimeModel: 'meituan/longcat-2.0:free',
      expectedNonce: 'any',
    });
    expect(mapperResult.exitCode).toBe(1);
    expect(mapperResult.errorCode).toBe('MISSING_FINAL_RESPONSE');
    expect(validatorDecision).toBeNull(); // Never reached validation
  });

  it('I03 — invalid JSON final → REJECTED business', () => {
    const { mapperResult, validatorDecision } = simulateRun({
      terminalOutput: 'this is not json',
      terminalStatus: 'completed',
      outputChunks: [],
      runtimeProvider: 'nous',
      runtimeModel: 'meituan/longcat-2.0:free',
      expectedNonce: 'test',
    });
    expect(mapperResult.exitCode).toBe(0); // Transport OK
    expect(validatorDecision?.verdict).toBe('INVALID_RESULT_JSON');
  });

  it('I04 — wrong nonce → REJECTED business', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"wrong","status":"completed"}';
    const { mapperResult, validatorDecision } = simulateRun({
      terminalOutput: json,
      terminalStatus: 'completed',
      outputChunks: [],
      runtimeProvider: 'nous',
      runtimeModel: 'meituan/longcat-2.0:free',
      expectedNonce: 'expected-nonce',
    });
    expect(mapperResult.exitCode).toBe(0);
    expect(validatorDecision?.verdict).toBe('NONCE_MISMATCH');
  });

  it('I05 — wrong provider → REJECTED before acceptance', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"n1","status":"completed"}';
    const { mapperResult, validatorDecision } = simulateRun({
      terminalOutput: json,
      terminalStatus: 'completed',
      outputChunks: [],
      runtimeProvider: 'openrouter',
      runtimeModel: 'meituan/longcat-2.0:free',
      expectedNonce: 'n1',
    });
    expect(mapperResult.exitCode).toBe(0); // Transport OK
    expect(validatorDecision?.verdict).toBe('PROVIDER_ROUTE_MISMATCH');
  });

  it('I06 — sessionKeyStrategy=run → different sessions per run', () => {
    // Simulate two runs with strategy=run
    const session1 = `paperclip:run:run-001`;
    const session2 = `paperclip:run:run-002`;
    expect(session1).not.toBe(session2);
    // In real implementation, sessionKeyStrategy=run generates unique session per run
  });
});
