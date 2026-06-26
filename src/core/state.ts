/**
 * F4 — Live state engine.
 *
 * Infers "who has the ball" in a session from the transcript's tail signal
 * (`LastSignal`, see parser) and from when its last activity was. It is READ-ONLY and derived:
 * nothing is saved, it is recomputed when the `.jsonl` changes.
 *
 *   🟢 working   — the assistant is working (it called a tool, or is about to respond).
 *   🟡 awaiting  — the assistant finished its turn and is waiting for you ("your turn").
 *   🔴 blocked   — it has been waiting for a tool result too long (possible permission/hang).
 *   ⚪ idle      — no recent activity (dormant topic); off the radar.
 *
 * `computeState` is a pure, testable function. The expensive orchestration (parsing, prefiltering
 * by mtime) lives in `liveStateOf`/`attentionCount`, which reuse the cached parsing from details.
 */

import type { LastSignal } from '../types';
import { getDetail } from './details';
import type { ProjectEntry } from './catalog';
import type { MetaStore } from './store';
import { resolveState, type HookSignal } from './liveSignal';

export type SessionState = 'working' | 'awaiting' | 'blocked' | 'idle';

export interface StateThresholds {
  /** A `tool_use` pending longer than this → `blocked` (possible permission). Default 60 s. */
  blockedAfterMs?: number;
  /** No activity longer than this → `idle` (dormant topic, off the radar). Default 15 min. */
  idleAfterMs?: number;
}

export const DEFAULT_BLOCKED_AFTER_MS = 60_000;
export const DEFAULT_IDLE_AFTER_MS = 15 * 60_000;

export interface StateInput extends StateThresholds {
  now: number;
  /** ms of the last activity (timestamp of the last event, or the file's mtime as a fallback). */
  lastActivityMs: number;
}

/**
 * Live state from the tail signal. Pure: same inputs → same output.
 * Order matters: first "dormant" (nothing recent), then it is classified by the last event.
 */
export function computeState(signal: LastSignal | null, input: StateInput): SessionState {
  const blockedAfter = input.blockedAfterMs ?? DEFAULT_BLOCKED_AFTER_MS;
  const idleAfter = input.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const age = input.now - input.lastActivityMs;

  if (!signal) return 'idle';
  if (age >= idleAfter) return 'idle'; // dormant topic: stays quiet even if something was left half-done

  switch (signal.kind) {
    case 'tool_use':
      // The assistant is waiting for a tool result. If it takes too long, we treat it
      // as blocked (usually a pending permission or a hang), not as normal work.
      return age >= blockedAfter ? 'blocked' : 'working';
    case 'tool_result':
    case 'user-message':
      return 'working';
    case 'assistant-message':
      // The assistant's turn is closed → your turn, unless it declared it is going to use a tool.
      return signal.stopReason === 'tool_use' ? 'working' : 'awaiting';
    default:
      return 'idle';
  }
}

/** Does this state demand your attention (counts toward the badge and blinks)? */
export function needsAttention(state: SessionState): boolean {
  return state === 'awaiting' || state === 'blocked';
}

/** Priority for ordering the tree: actionable items on top. Lower = higher up. */
export function statePriority(state: SessionState): number {
  switch (state) {
    case 'blocked':
      return 0;
    case 'awaiting':
      return 1;
    case 'working':
      return 2;
    case 'idle':
      return 3;
  }
}

/**
 * Live state of a session by its path. Parses (cached by mtime) to read the tail signal
 * and the last timestamp. Does not throw: on any read failure it returns `idle`.
 */
export function liveStateOf(
  path: string,
  mtimeMs: number,
  now: number,
  thresholds: StateThresholds = {},
): SessionState {
  let signal: LastSignal | null = null;
  let lastActivityMs = mtimeMs;
  try {
    const detail = getDetail(path);
    signal = detail.lastSignal;
    const parsed = detail.lastTs ? Date.parse(detail.lastTs) : NaN;
    if (!Number.isNaN(parsed)) lastActivityMs = parsed;
  } catch {
    return 'idle';
  }
  return computeState(signal, { now, lastActivityMs, ...thresholds });
}

export interface AttentionCount {
  awaiting: number;
  blocked: number;
  /** awaiting + blocked: total of topics demanding your attention. */
  total: number;
}

export interface LiveScan {
  /** State by sessionId of ALL sessions (dormant ones are marked `idle` without parsing). */
  states: Map<string, SessionState>;
  /** Count of those demanding your attention (excludes archived/hidden and the open session). */
  count: AttentionCount;
}

/**
 * A single pass over all projects: computes the state of each session and counts those
 * demanding your attention. Single source for the tree (which caches `states`) and for the badge.
 *
 * Efficient on purpose: it only parses sessions whose `mtime` is recent (within the inactivity
 * window); a session without recent writes can only be `idle`, so it is marked without
 * touching disk. The count excludes archived/hidden and `excludeId` (the open one: you don't notify yourself).
 */
export function liveScan(
  projects: ProjectEntry[],
  store: MetaStore,
  now: number,
  opts: { excludeId?: string | null; thresholds?: StateThresholds; signals?: Map<string, HookSignal> } = {},
): LiveScan {
  const thresholds = opts.thresholds ?? {};
  const idleAfter = thresholds.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const signals = opts.signals;
  const states = new Map<string, SessionState>();
  let awaiting = 0;
  let blocked = 0;
  for (const p of projects) {
    for (const s of p.sessions) {
      const fallback: SessionState =
        now - s.mtimeMs >= idleAfter ? 'idle' : liveStateOf(s.path, s.mtimeMs, now, thresholds);
      // A fresh hook signal (F5) is authoritative and overrides the transcript inference.
      const state: SessionState = signals
        ? resolveState(signals.get(s.id) ?? null, fallback, now, idleAfter)
        : fallback;
      states.set(s.id, state);
      if (s.id === opts.excludeId) continue;
      const meta = store.get(s.id);
      if (meta.hidden || meta.archived) continue;
      if (state === 'awaiting') awaiting++;
      else if (state === 'blocked') blocked++;
    }
  }
  return { states, count: { awaiting, blocked, total: awaiting + blocked } };
}
