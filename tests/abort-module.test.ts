// tests/abort-module.test.ts
import { describe, it, expect } from 'vitest';
import {
  AbortReason,
  createAbortError,
  isAbortError,
  getAbortReason,
  ABORT_ERROR_NAME,
} from '../src/abort.js';

describe('abort module', () => {
  it('AbortReason enum has required values', () => {
    expect(AbortReason.UserInterrupted).toBe('user_interrupted');
    expect(AbortReason.UserExplicitCancel).toBe('user_explicit_cancel');
    expect(AbortReason.Timeout).toBe('timeout');
    expect(AbortReason.SiblingError).toBe('sibling_error');
    expect(AbortReason.ServerShutdown).toBe('server_shutdown');
  });

  it('createAbortError produces Error with name=AbortError and reason', () => {
    const e = createAbortError(AbortReason.UserExplicitCancel);
    expect(e.name).toBe(ABORT_ERROR_NAME);
    expect(e.message).toContain('user_explicit_cancel');
    expect(getAbortReason(e)).toBe(AbortReason.UserExplicitCancel);
  });

  it('isAbortError recognizes errors from createAbortError', () => {
    const e = createAbortError(AbortReason.Timeout);
    expect(isAbortError(e)).toBe(true);
  });

  it('isAbortError returns false for non-abort errors', () => {
    expect(isAbortError(new Error('normal'))).toBe(false);
    expect(isAbortError('string')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it('isAbortError recognizes native DOMException AbortError', () => {
    // Native fetch() with abort signal rejects with DOMException name=AbortError
    const e = new DOMException('aborted', 'AbortError');
    expect(isAbortError(e)).toBe(true);
  });

  it('getAbortReason returns undefined when error has no encoded reason', () => {
    expect(getAbortReason(new Error('normal'))).toBeUndefined();
    expect(getAbortReason(new DOMException('x', 'AbortError'))).toBeUndefined();
  });
});
