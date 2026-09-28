/**
 * E01-E08: Contract verification tests for hermes-gateway adapter.
 * Uses mapFinalResultForTest — no LLM calls, no real Hermes server.
 */
import { describe, it, expect } from 'vitest';
import { mapFinalResultForTest } from './execute.js';

describe('E01-E08: Hermes Gateway Adapter Contract Verification', () => {

  describe('E01 — Direct final response', () => {
    it('should succeed with JSON output from assistant.final event', () => {
      const expectedJson = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"test123","status":"completed"}';
      const result = mapFinalResultForTest({
        terminal: {
          runId: 'test-run-123',
          status: 'completed',
          eventName: 'run.completed',
          payload: { status: 'completed', output: expectedJson },
          output: expectedJson,
        },
        outputChunks: [expectedJson],
        sessionKey: 'test-session',
        strategy: 'run',
      });
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain(expectedJson);
    });
  });

  describe('E02 — READ_FILE then final response', () => {
    it('should use only terminal.output as result, not outputChunks', () => {
      const finalJson = '{"protocol":"PC-MIG-006E","status":"completed"}';
      const toolText = 'I need to read the file first...';
      const result = mapFinalResultForTest({
        terminal: {
          runId: 'test-run-123',
          status: 'completed',
          eventName: 'run.completed',
          payload: { status: 'completed', output: finalJson },
          output: finalJson,
        },
        outputChunks: [toolText, finalJson],
        sessionKey: 'test-session',
        strategy: 'run',
      });
      expect(result.summary).toContain(finalJson);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('E03 — READ_FILE without final response (BUG DOCUMENTATION)', () => {
    it('CURRENT BUG: outputChunks become result when terminal.output is null', () => {
      const toolText = 'Let me read the file...';
      const result = mapFinalResultForTest({
        terminal: {
          runId: 'test-run-123',
          status: 'completed',
          eventName: 'run.completed',
          payload: { status: 'completed', output: null },
          output: null,
        },
        outputChunks: [toolText],
        sessionKey: 'test-session',
        strategy: 'run',
      });
      // H3 FIX: adapter now rejects runs without final response
      // Tool call text goes to diagnosticTranscript only
      expect(result.exitCode).toBe(1); // H3 FIX: missing final = failure
      expect(result.errorCode).toBe('MISSING_FINAL_RESPONSE');
      expect(result.diagnosticTranscript).toBe(toolText); // chunks go to diagnostic
    });
  });

  describe('E04 — Transcript text before final response', () => {
    it('terminal.output takes precedence over outputChunks', () => {
      const reasoningText = 'Let me think about this...';
      const finalJson = '{"protocol":"PC-MIG-006E","status":"completed"}';
      const result = mapFinalResultForTest({
        terminal: {
          runId: 'test-run-123',
          status: 'completed',
          eventName: 'run.completed',
          payload: { status: 'completed', output: finalJson },
          output: finalJson,
        },
        outputChunks: [reasoningText, finalJson],
        sessionKey: 'test-session',
        strategy: 'run',
      });
      // terminal.output should win
      expect(result.summary).toContain(finalJson);
    });
  });

  describe('E05 — Provider/model extraction', () => {
    it('should extract provider and model from terminal payload', () => {
      const result = mapFinalResultForTest({
        terminal: {
          runId: 'test-run-123',
          status: 'completed',
          eventName: 'run.completed',
          payload: { status: 'completed', provider: 'nous', model: 'meituan/longcat-2.0:free', output: 'response' },
          output: 'response',
        },
        outputChunks: ['response'],
        sessionKey: 'test-session',
        strategy: 'run',
      });
      expect(result.model).toBe('meituan/longcat-2.0:free');
    });
  });

  describe('E06 — Session strategy', () => {
    it('sessionKeyStrategy=run should produce new session params', () => {
      const result = mapFinalResultForTest({
        terminal: {
          runId: 'test-run-123',
          status: 'completed',
          eventName: 'run.completed',
          payload: { status: 'completed', output: 'response' },
          output: 'response',
        },
        outputChunks: ['response'],
        sessionKey: 'paperclip:run:abc123',
        strategy: 'run',
      });
      expect(result.sessionParams?.strategy).toBe('run');
    });
  });

  describe('E07 — Invalid JSON passthrough', () => {
    it('adapter passes through whatever output it gets', () => {
      const invalidJson = 'this is not json';
      const result = mapFinalResultForTest({
        terminal: {
          runId: 'test-run-123',
          status: 'completed',
          eventName: 'run.completed',
          payload: { status: 'completed', output: invalidJson },
          output: invalidJson,
        },
        outputChunks: [invalidJson],
        sessionKey: 'test-session',
        strategy: 'run',
      });
      expect(result.summary).toBe(invalidJson);
    });
  });

  describe('E08 — Nonce preservation', () => {
    it('should preserve exact nonce in output', () => {
      const expectedNonce = 'abc123def456';
      const correctJson = `{"protocol":"PC-MIG-006E","nonce":"${expectedNonce}","status":"completed"}`;
      const result = mapFinalResultForTest({
        terminal: {
          runId: 'test-run-123',
          status: 'completed',
          eventName: 'run.completed',
          payload: { status: 'completed', output: correctJson },
          output: correctJson,
        },
        outputChunks: [correctJson],
        sessionKey: 'test-session',
        strategy: 'run',
      });
      expect(result.summary).toContain(expectedNonce);
    });
  });
});
