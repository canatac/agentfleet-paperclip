/**
 * V01-V08: Tests for PC-MIG validator (Level B).
 */
import { describe, it, expect } from 'vitest';
import { validatePcMiGResult } from './pc-mig-validator.js';

describe('V01-V008: PC-MIG Validator', () => {

  it('V01 — exact JSON + exact nonce → ACCEPTED', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"abc123","status":"completed"}';
    const decision = validatePcMiGResult(json, 'abc123', 'nous', 'meituan/longcat-2.0:free');
    expect(decision.verdict).toBe('ACCEPTED');
    expect(decision.result?.nonce).toBe('abc123');
  });

  it('V02 — invalid JSON → INVALID_RESULT_JSON', () => {
    const decision = validatePcMiGResult('not json at all', 'abc123', 'nous', 'meituan/longcat-2.0:free');
    expect(decision.verdict).toBe('INVALID_RESULT_JSON');
  });

  it('V03 — different nonce → NONCE_MISMATCH', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"wrong","status":"completed"}';
    const decision = validatePcMiGResult(json, 'expected', 'nous', 'meituan/longcat-2.0:free');
    expect(decision.verdict).toBe('NONCE_MISMATCH');
  });

  it('V04 — missing field → RESULT_SCHEMA_MISMATCH', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"abc123"}';
    const decision = validatePcMiGResult(json, 'abc123', 'nous', 'meituan/longcat-2.0:free');
    expect(decision.verdict).toBe('RESULT_SCHEMA_MISMATCH');
    expect(decision.reason).toContain('status');
  });

  it('V05 — extra forbidden field → RESULT_SCHEMA_MISMATCH', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"abc123","status":"completed","extra":"not allowed"}';
    const decision = validatePcMiGResult(json, 'abc123', 'nous', 'meituan/longcat-2.0:free');
    expect(decision.verdict).toBe('RESULT_SCHEMA_MISMATCH');
    expect(decision.reason).toContain('extra');
  });

  it('V06 — runtime provider != nous → PROVIDER_ROUTE_MISMATCH', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"abc123","status":"completed"}';
    const decision = validatePcMiGResult(json, 'abc123', 'openrouter', 'meituan/longcat-2.0:free');
    expect(decision.verdict).toBe('PROVIDER_ROUTE_MISMATCH');
  });

  it('V07 — runtime model different → MODEL_ROUTE_MISMATCH', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"abc123","status":"completed"}';
    const decision = validatePcMiGResult(json, 'abc123', 'nous', 'gpt-4');
    expect(decision.verdict).toBe('MODEL_ROUTE_MISMATCH');
  });

  it('V08 — missing runtime metadata → RUNTIME_METADATA_MISSING', () => {
    const json = '{"protocol":"PC-MIG-006E","provider":"nous","model":"meituan/longcat-2.0:free","nonce":"abc123","status":"completed"}';
    const decision = validatePcMiGResult(json, 'abc123', undefined, undefined);
    expect(decision.verdict).toBe('RUNTIME_METADATA_MISSING');
  });
});
