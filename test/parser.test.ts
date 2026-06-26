import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTranscript, parseTranscriptFile } from '../src/parser';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);

describe('parseTranscript — basic session', () => {
  const s = parseTranscriptFile(fixture('basic.jsonl'));

  it('extracts session metadata (id, cwd, branch, title)', () => {
    expect(s.sessionId).toBe('sess-basic');
    expect(s.cwd).toBe('/Users/x/proj');
    expect(s.gitBranch).toBe('main');
    expect(s.title).toBe('Arreglar heatmap');
  });

  it('includes only human and assistant turns (excludes tool_result and sidechain)', () => {
    expect(s.messages).toHaveLength(3);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(s.messages[0]!.text).toBe('arregla el tracking de visitas');
    expect(s.messages[2]!.text).toBe('gracias');
  });

  it('separates thinking and tools from the visible assistant text', () => {
    const a = s.messages[1]!;
    expect(a.role).toBe('assistant');
    expect(a.text.startsWith('Listo, lo arreglé.')).toBe(true);
    expect(a.thinking).toBe('pienso en la causa');
    expect(a.tools).toEqual(['Edit']);
  });

  it('detects the recap and anchors it to its message', () => {
    expect(s.recaps).toHaveLength(1);
    expect(s.recaps[0]!.text).toBe('arreglé el tracking de visitas y quedó desplegado');
    expect(s.recaps[0]!.messageIndex).toBe(1);
  });

  it('computes first and last timestamp', () => {
    expect(s.firstTs).toBe('2026-06-24T10:00:00Z');
    expect(s.lastTs).toBe('2026-06-24T10:03:00Z');
  });
});

describe('parseTranscript — recap in user meta event', () => {
  const s = parseTranscriptFile(fixture('recap-in-user.jsonl'));

  it('recognizes recaps that live in user/meta events', () => {
    expect(s.recaps).toHaveLength(1);
    expect(s.recaps[0]!.text).toBe('Goal: turn the agent-creation assistant into a full assistant');
    expect(s.recaps[0]!.messageIndex).toBe(0);
  });

  it('marks isMeta events as meta', () => {
    expect(s.messages[0]!.meta).toBe(true);
  });
});

describe('parseTranscript — real format ※ recap: and **Recap:**', () => {
  const s = parseTranscriptFile(fixture('real-recap.jsonl'));

  it('detects the native recap with the ※ marker and strips the prefix', () => {
    expect(s.recaps[0]!.text).toBe('Goal: make Meeting-IA join reliably');
    expect(s.recaps[0]!.messageIndex).toBe(1);
  });

  it('also detects a **Recap:** in assistant markdown, with no leftovers', () => {
    const last = s.recaps[s.recaps.length - 1]!;
    expect(last.text).toBe('- desplegado y verificado');
  });

  it('does not confuse a quoted "recap:" mid-sentence', () => {
    const r = parseTranscript(
      '{"type":"user","message":{"role":"user","content":"como dije: \\"recap: esto es una cita\\" fin"}}',
    );
    expect(r.recaps).toHaveLength(0);
  });
});

describe('parseTranscript — robustness', () => {
  const s = parseTranscriptFile(fixture('malformed.jsonl'));

  it('discards non-JSON lines and empty events without throwing', () => {
    expect(s.title).toBe('Robustez');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.text).toBe('hola');
    expect(s.stats.lines).toBe(4); // ai-title, garbage, user, empty-assistant (blank does not count)
    expect(s.stats.skipped).toBe(2); // non-JSON garbage + assistant without content
  });

  it('uses the file name as a fallback sessionId when needed', () => {
    const viaString = parseTranscript('{"type":"user","message":{"role":"user","content":"hi"}}', 'fallback-id');
    expect(viaString.sessionId).toBe('fallback-id');
  });
});
