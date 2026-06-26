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

/** Default freshness window for a hook signal (mirrors the idle window in state.ts). */
const DEFAULT_FRESHNESS_MS = 15 * 60_000;

/** What a hook told us about a session, mapped from the Claude Code event that fired. */
export type SignalKind = 'working' | 'awaiting' | 'blocked' | 'session-end';

export interface HookSignal {
  kind: SignalKind;
  /** ms timestamp when the hook fired. */
  ts: number;
}

/**
 * Map a Claude Code hook event to a signal kind, or null if the event carries no useful state.
 * `notificationType` is only set for the `Notification` event (e.g. 'permission_prompt',
 * 'idle_prompt', 'auth_success', 'elicitation_dialog'). Kept in sync with the hook helper script.
 */
export function signalKindForEvent(event: string, notificationType?: string | null): SignalKind | null {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working';
    case 'Stop':
      return 'awaiting';
    case 'SessionEnd':
      return 'session-end';
    case 'Notification':
      switch (notificationType) {
        case 'idle_prompt':
          return 'awaiting';
        case 'permission_prompt':
        case 'elicitation_dialog':
          return 'blocked'; // Claude needs your approval/input to continue
        default:
          return null; // auth_success, elicitation_complete, unknown… not attention
      }
    default:
      return null;
  }
}

const SIGNAL_KINDS: readonly SignalKind[] = ['working', 'awaiting', 'blocked', 'session-end'];

/** Parse the contents of a signal file into a HookSignal, or null if invalid. */
export function parseSignal(text: string): HookSignal | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const { kind, ts } = obj as Record<string, unknown>;
  if (typeof kind !== 'string' || !SIGNAL_KINDS.includes(kind as SignalKind)) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return { kind: kind as SignalKind, ts };
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
  freshnessMs: number = DEFAULT_FRESHNESS_MS,
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
