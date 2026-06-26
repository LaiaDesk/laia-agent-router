/**
 * F5 — Live signal from Claude Code hooks.
 *
 * Claude Code can run hooks on session events (PreToolUse/PostToolUse, Stop, Notification,
 * SessionEnd). A tiny helper writes the latest event per session to a signal file; the extension
 * watches those files. This module turns that raw signal into a SessionState, taking precedence
 * over the transcript-based inference in `state.ts` when the signal is fresh.
 *
 * `resolveState` is pure and testable. Source of truth precedence:
 *   fresh hook signal  >  transcript inference (computeState)  >  idle
 */

import type { SessionState } from './state';
import { DEFAULT_IDLE_AFTER_MS } from './state';

/** What a hook told us about a session, mapped from the Claude Code event that fired. */
export type SignalKind = 'working' | 'awaiting' | 'blocked' | 'session-end';

export interface HookSignal {
  kind: SignalKind;
  /** ms timestamp when the hook fired. */
  ts: number;
}

/**
 * Resolve the live state of a session. If a hook signal is fresh (within `freshnessMs`), it wins;
 * otherwise we defer to `fallback` (the transcript-inferred state from computeState).
 * A fresh `session-end` means the session closed → idle.
 */
export function resolveState(
  signal: HookSignal | null,
  fallback: SessionState,
  now: number,
  freshnessMs: number = DEFAULT_IDLE_AFTER_MS,
): SessionState {
  if (!signal) return fallback;
  if (now - signal.ts >= freshnessMs) return fallback; // stale: the hook is no longer authoritative
  switch (signal.kind) {
    case 'working':
      return 'working';
    case 'awaiting':
      return 'awaiting';
    case 'blocked':
      return 'blocked';
    case 'session-end':
      return 'idle';
  }
}
