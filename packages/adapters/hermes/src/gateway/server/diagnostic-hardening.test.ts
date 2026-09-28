import { describe, it, expect } from 'vitest';
import { mapFinalResultForTest } from './execute.js';

describe('S01-S06: Diagnostic Hardening', () => {

  it('S01 — transcript with Bearer token → redacted', () => {
    const secretToken = 'sk-supersecret123456';
    const final = '{"protocol":"PC-MIG-006E","status":"completed"}';
    const result = mapFinalResultForTest({
      terminal: {
        runId: 'r1', status: 'completed', eventName: 'run.completed',
        payload: { status: 'completed', output: final }, output: final,
      },
      outputChunks: ['Authorization: Bearer ' + secretToken, 'More text'],
      sessionKey: 's1', strategy: 'run',
    });
    expect(result.diagnosticTranscript).not.toContain(secretToken);
    expect(result.summary).toBe(final);
  });

  it('S02 — tool result with message → MISSING_FINAL_RESPONSE', () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: 'r1', status: 'completed', eventName: 'run.completed',
        payload: { status: 'completed', tool_results: [{ message: 'fake final' }] },
        output: null,
      },
      outputChunks: ['tool result'], sessionKey: 's1', strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
  });

  it('S03 — tool result with result field → MISSING_FINAL_RESPONSE', () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: 'r1', status: 'completed', eventName: 'run.completed',
        payload: { status: 'completed', tool_results: [{ result: 'fake final' }] },
        output: null,
      },
      outputChunks: ['tool result'], sessionKey: 's1', strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
  });

  it('S04 — transcript >5000 chars → truncated', () => {
    const longChunk = 'A'.repeat(6000);
    const final = '{"protocol":"PC-MIG-006E","status":"completed"}';
    const result = mapFinalResultForTest({
      terminal: {
        runId: 'r1', status: 'completed', eventName: 'run.completed',
        payload: { status: 'completed', output: final }, output: final,
      },
      outputChunks: [longChunk], sessionKey: 's1', strategy: 'run',
    });
    expect(result.diagnosticTranscript).toBeTruthy();
    expect(result.diagnosticTranscript!.length).toBeLessThanOrEqual(5200);
    expect(result.diagnosticTranscript).toContain('[TRUNCATED');
  });

  it('S06 — missing final on completed → MISSING_FINAL_RESPONSE', () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: 'r1', status: 'completed', eventName: 'run.completed',
        payload: { status: 'completed' }, output: null,
      },
      outputChunks: ['partial output'], sessionKey: 's1', strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
    expect(result.diagnosticTranscript).toContain('partial output');
  });
});
