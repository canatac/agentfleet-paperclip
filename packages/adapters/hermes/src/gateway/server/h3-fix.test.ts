/**
 * A01-A10: Tests for H3 fix — reject runs without final response.
 */
import { describe, it, expect } from 'vitest';
import { mapFinalResultForTest } from './execute.js';

function makeTerminal(status: string, output: string | null, payload: Record<string, any> = {}) {
  return {
    runId: 'test-run',
    status,
    eventName: `run.${status}`,
    payload: { status, ...payload },
    output,
  };
}

describe('A01-A10: H3 Fix — Reject runs without final response', () => {

  it('A01 — explicit final output → success with exact output', () => {
    const final = '{"protocol":"PC-MIG-006E","status":"completed"}';
    const result = mapFinalResultForTest({
      terminal: makeTerminal('completed', final, { output: final }),
      outputChunks: [],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(final);
    expect(result.errorCode).toBeUndefined();
  });

  it('A02 — tool call then final → only final returned', () => {
    const final = '{"protocol":"PC-MIG-006E","status":"completed"}';
    const result = mapFinalResultForTest({
      terminal: makeTerminal('completed', final, { output: final }),
      outputChunks: ['Reading tool output...', final],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(final);
  });

  it('A03 — tool call without final → MISSING_FINAL_RESPONSE', () => {
    const result = mapFinalResultForTest({
      terminal: makeTerminal('completed', null),
      outputChunks: ['Let me read the file...'],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
    expect(result.summary).toBeUndefined();
  });

  it('A04 — reasoning without final → MISSING_FINAL_RESPONSE', () => {
    const result = mapFinalResultForTest({
      terminal: makeTerminal('completed', null),
      outputChunks: ['Let me think about this task...', 'The approach should be...'],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
  });

  it('A05 — text chunks without final → MISSING_FINAL_RESPONSE', () => {
    const result = mapFinalResultForTest({
      terminal: makeTerminal('completed', null),
      outputChunks: ['Some text from the model', 'More text'],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
    // Chunks should be in diagnostic only
    expect(result.diagnosticTranscript).toContain('Some text from the model');
    expect(result.summary).toBeUndefined();
  });

  it('A06 — run.failed → failure with cause', () => {
    const result = mapFinalResultForTest({
      terminal: makeTerminal('failed', null, { error: 'Provider quota exceeded' }),
      outputChunks: [],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('quota exceeded');
  });

  it('A07 — run.cancelled → RUN_CANCELLED', () => {
    const result = mapFinalResultForTest({
      terminal: makeTerminal('cancelled', null),
      outputChunks: [],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('RUN_CANCELLED');
  });

  it('A08 — timeout is handled by caller (not mapFinalResultForTest)', () => {
    // Timeout is handled in the execute() function, not in mapFinalResultForTest
    // This test documents that timeout is a separate concern
    const result = mapFinalResultForTest({
      terminal: { ...makeTerminal('completed', null), status: 'completed' },
      outputChunks: [],
      sessionKey: 's1',
      strategy: 'run',
    });
    // Without final response, it's MISSING_FINAL_RESPONSE
    expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
  });

  it('A09 — empty final string → MISSING_FINAL_RESPONSE', () => {
    const result = mapFinalResultForTest({
      terminal: makeTerminal('completed', '   '),
      outputChunks: ['Some text'],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
  });

  it('A10 — multiple chunks then final → only final returned', () => {
    const final = '{"protocol":"PC-MIG-006E","status":"completed"}';
    const result = mapFinalResultForTest({
      terminal: makeTerminal('completed', final, { output: final }),
      outputChunks: ['chunk1', 'chunk2', 'chunk3', final],
      sessionKey: 's1',
      strategy: 'run',
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(final);
    // Chunks in diagnostic
    expect(result.diagnosticTranscript).toContain('chunk1');
  });
});
