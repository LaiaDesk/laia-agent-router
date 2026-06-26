import { describe, it, expect } from 'vitest';
import { resolveState, signalKindForEvent, type HookSignal } from '../src/core/liveSignal';

const now = 1_000_000;
const fresh = (extra: Partial<HookSignal> = {}): HookSignal => ({ kind: 'working', ts: now - 1000, ...extra });

describe('resolveState', () => {
  it('returns the fallback when there is no hook signal', () => {
    expect(resolveState(null, 'awaiting', now)).toBe('awaiting');
  });

  it('a fresh hook signal overrides the transcript-inferred fallback', () => {
    // Transcript guessed "working", but Claude Code told us the turn closed.
    expect(resolveState(fresh({ kind: 'awaiting' }), 'working', now)).toBe('awaiting');
  });

  it('maps a fresh "blocked" signal to blocked', () => {
    expect(resolveState(fresh({ kind: 'blocked' }), 'working', now)).toBe('blocked');
  });

  it('maps a fresh "working" signal to working', () => {
    expect(resolveState(fresh({ kind: 'working' }), 'idle', now)).toBe('working');
  });

  it('maps a fresh "session-end" signal to idle', () => {
    expect(resolveState(fresh({ kind: 'session-end' }), 'working', now)).toBe('idle');
  });

  it('ignores a stale hook signal and uses the fallback', () => {
    const stale: HookSignal = { kind: 'working', ts: now - (16 * 60_000) }; // older than idle window
    expect(resolveState(stale, 'idle', now)).toBe('idle');
  });

  it('honors a custom freshness window', () => {
    const sig: HookSignal = { kind: 'working', ts: now - 5000 };
    expect(resolveState(sig, 'idle', now, 2000)).toBe('idle'); // 5s old, window 2s -> stale -> fallback
    expect(resolveState(sig, 'idle', now, 10_000)).toBe('working'); // within 10s window
  });
});

describe('signalKindForEvent', () => {
  it('maps activity events to working', () => {
    expect(signalKindForEvent('UserPromptSubmit')).toBe('working');
    expect(signalKindForEvent('PreToolUse')).toBe('working');
    expect(signalKindForEvent('PostToolUse')).toBe('working');
  });

  it('maps Stop to awaiting (your turn)', () => {
    expect(signalKindForEvent('Stop')).toBe('awaiting');
  });

  it('maps Notification by notification_type', () => {
    expect(signalKindForEvent('Notification', 'idle_prompt')).toBe('awaiting');
    expect(signalKindForEvent('Notification', 'permission_prompt')).toBe('blocked');
    expect(signalKindForEvent('Notification', 'elicitation_dialog')).toBe('blocked');
  });

  it('ignores notifications that are not attention (returns null)', () => {
    expect(signalKindForEvent('Notification', 'auth_success')).toBeNull();
    expect(signalKindForEvent('Notification')).toBeNull(); // unknown/missing type
  });

  it('maps SessionEnd to session-end', () => {
    expect(signalKindForEvent('SessionEnd')).toBe('session-end');
  });

  it('returns null for events we do not track', () => {
    expect(signalKindForEvent('SessionStart')).toBeNull();
    expect(signalKindForEvent('PreCompact')).toBeNull();
    expect(signalKindForEvent('whatever')).toBeNull();
  });
});
