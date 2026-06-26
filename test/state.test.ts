import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript } from '../src/parser';
import {
  computeState,
  liveScan,
  needsAttention,
  statePriority,
  DEFAULT_BLOCKED_AFTER_MS,
  DEFAULT_IDLE_AFTER_MS,
} from '../src/core/state';
import { clearDetailCache } from '../src/core/details';
import type { ProjectEntry } from '../src/core/catalog';
import type { MetaStore } from '../src/core/store';
import type { LastSignal } from '../src/types';

const NOW = Date.parse('2026-06-25T12:00:00Z');
const sig = (kind: LastSignal['kind'], stopReason: string | null = null): LastSignal => ({
  kind,
  ts: null,
  stopReason,
});

describe('computeState — who has the ball', () => {
  const fresh = { now: NOW, lastActivityMs: NOW - 5_000 };

  it('assistant with recent tool_use → working', () => {
    expect(computeState(sig('tool_use'), fresh)).toBe('working');
  });

  it('tool_use pending longer than the threshold → blocked', () => {
    const old = { now: NOW, lastActivityMs: NOW - (DEFAULT_BLOCKED_AFTER_MS + 1_000) };
    expect(computeState(sig('tool_use'), old)).toBe('blocked');
  });

  it('tool result just arrived → working (Claude is about to respond)', () => {
    expect(computeState(sig('tool_result'), fresh)).toBe('working');
  });

  it('human message just sent → working', () => {
    expect(computeState(sig('user-message'), fresh)).toBe('working');
  });

  it('assistant turn closed → awaiting (your turn)', () => {
    expect(computeState(sig('assistant-message', 'end_turn'), fresh)).toBe('awaiting');
  });

  it('assistant with stop_reason tool_use → working (not your turn yet)', () => {
    expect(computeState(sig('assistant-message', 'tool_use'), fresh)).toBe('working');
  });

  it('no signal → idle', () => {
    expect(computeState(null, fresh)).toBe('idle');
  });

  it('no activity past the inactivity window → idle, even if it were your turn', () => {
    const dormant = { now: NOW, lastActivityMs: NOW - (DEFAULT_IDLE_AFTER_MS + 1_000) };
    expect(computeState(sig('assistant-message', 'end_turn'), dormant)).toBe('idle');
    expect(computeState(sig('tool_use'), dormant)).toBe('idle');
  });

  it('respects custom thresholds', () => {
    const s = computeState(sig('tool_use'), {
      now: NOW,
      lastActivityMs: NOW - 2_000,
      blockedAfterMs: 1_000,
    });
    expect(s).toBe('blocked');
  });
});

describe('needsAttention / statePriority', () => {
  it('only awaiting and blocked claim attention', () => {
    expect(needsAttention('awaiting')).toBe(true);
    expect(needsAttention('blocked')).toBe(true);
    expect(needsAttention('working')).toBe(false);
    expect(needsAttention('idle')).toBe(false);
  });

  it('sorts the actionable ones on top: blocked < awaiting < working < idle', () => {
    expect(statePriority('blocked')).toBeLessThan(statePriority('awaiting'));
    expect(statePriority('awaiting')).toBeLessThan(statePriority('working'));
    expect(statePriority('working')).toBeLessThan(statePriority('idle'));
  });
});

describe('parser — tail signal (lastSignal)', () => {
  it('last event = assistant with tool_use → kind tool_use', () => {
    const s = parseTranscript(
      [
        '{"type":"user","message":{"role":"user","content":"haz X"}}',
        '{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","name":"Edit"}]}}',
      ].join('\n'),
    );
    expect(s.lastSignal?.kind).toBe('tool_use');
    expect(s.lastSignal?.stopReason).toBe('tool_use');
  });

  it('last event = assistant text only → kind assistant-message (your turn)', () => {
    const s = parseTranscript(
      [
        '{"type":"user","message":{"role":"user","content":"haz X"}}',
        '{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hecho"}]}}',
      ].join('\n'),
    );
    expect(s.lastSignal?.kind).toBe('assistant-message');
    expect(s.lastSignal?.stopReason).toBe('end_turn');
  });

  it('last event = tool_result → kind tool_result (not confused with a human message)', () => {
    const s = parseTranscript(
      [
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash"}]}}',
        '{"type":"user","toolUseResult":"ok","message":{"role":"user","content":[{"type":"tool_result","content":"done"}]}}',
      ].join('\n'),
    );
    expect(s.lastSignal?.kind).toBe('tool_result');
  });

  it('ignores sidechain when computing the tail signal', () => {
    const s = parseTranscript(
      [
        '{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"te toca"}]}}',
        '{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"tool_use","name":"X"}]}}',
      ].join('\n'),
    );
    expect(s.lastSignal?.kind).toBe('assistant-message');
  });

  it('empty transcript → lastSignal null', () => {
    expect(parseTranscript('').lastSignal).toBeNull();
  });
});

describe('liveScan — single pass: states + attention count', () => {
  const ASSISTANT_DONE =
    '{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hecho"}]}}';
  const dir = mkdtempSync(join(tmpdir(), 'laia-livescan-'));
  const now = Date.now();

  // Three recent "your turn" sessions + one dormant (old mtime).
  const mkSession = (id: string, ageMs: number) => {
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, ASSISTANT_DONE);
    const t = (now - ageMs) / 1000;
    utimesSync(path, t, t);
    return { id, path, projectKey: 'p', mtimeMs: now - ageMs, sizeBytes: 1 };
  };

  const sessions = [
    mkSession('fresh-a', 5_000),
    mkSession('fresh-b', 5_000),
    mkSession('dormant', DEFAULT_IDLE_AFTER_MS + 60_000),
  ];
  const projects: ProjectEntry[] = [
    { key: 'p', dir, displayName: '/p', sessions, lastActivityMs: now },
  ];

  const store = (overrides: Record<string, { hidden?: boolean; archived?: boolean }> = {}) =>
    ({ get: (id: string) => overrides[id] ?? {} }) as unknown as MetaStore;

  it('marks dormant ones idle without parsing and counts only the ones that claim attention', () => {
    clearDetailCache();
    const { states, count } = liveScan(projects, store(), now, {});
    expect(states.get('fresh-a')).toBe('awaiting');
    expect(states.get('fresh-b')).toBe('awaiting');
    expect(states.get('dormant')).toBe('idle');
    expect(count).toEqual({ awaiting: 2, blocked: 0, total: 2 });
  });

  it('excludes the open session from the count (focus rule) but includes it in states', () => {
    clearDetailCache();
    const { states, count } = liveScan(projects, store(), now, { excludeId: 'fresh-a' });
    expect(states.get('fresh-a')).toBe('awaiting'); // still in the map
    expect(count.total).toBe(1); // but does not count toward the badge
  });

  it('excludes archived and hidden ones from the count', () => {
    clearDetailCache();
    const { count } = liveScan(projects, store({ 'fresh-a': { archived: true }, 'fresh-b': { hidden: true } }), now, {});
    expect(count.total).toBe(0);
  });
});
