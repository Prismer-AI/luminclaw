/**
 * Structured abort reasons + helpers for encoding them in Error objects.
 *
 * Used across both dialogue and execution loops to distinguish why an
 * in-flight operation was cancelled.  TS uses native AbortController with
 * `signal.reason` carrying an Error whose `message` encodes one of these enum
 * values.
 *
 * @module abort
 */

export const ABORT_ERROR_NAME = 'AbortError';

export const AbortReason = {
  UserInterrupted: 'user_interrupted',
  UserExplicitCancel: 'user_explicit_cancel',
  Timeout: 'timeout',
  SiblingError: 'sibling_error',
  ServerShutdown: 'server_shutdown',
} as const;

export type AbortReasonValue = typeof AbortReason[keyof typeof AbortReason];

const REASON_PREFIX = 'abort:';

/** Construct an Error that both looks like a native AbortError and encodes a structured reason. */
export function createAbortError(reason: AbortReasonValue): Error {
  const err = new Error(`${REASON_PREFIX}${reason}`);
  err.name = ABORT_ERROR_NAME;
  return err;
}

/** True if the value looks like an abort (DOMException AbortError, or our structured Error). */
export function isAbortError(value: unknown): boolean {
  if (value instanceof Error && value.name === ABORT_ERROR_NAME) return true;
  if (typeof value === 'object' && value !== null && 'name' in value &&
      (value as { name?: string }).name === ABORT_ERROR_NAME) return true;
  return false;
}

/** Extract the encoded reason from a structured abort Error; undefined otherwise. */
export function getAbortReason(value: unknown): AbortReasonValue | undefined {
  if (!isAbortError(value)) return undefined;
  const msg = (value as { message?: string }).message ?? '';
  if (!msg.startsWith(REASON_PREFIX)) return undefined;
  const r = msg.slice(REASON_PREFIX.length) as AbortReasonValue;
  const known: string[] = Object.values(AbortReason);
  return known.includes(r) ? r : undefined;
}
