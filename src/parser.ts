/**
 * F0 — Parser for Claude Code `.jsonl` transcripts.
 *
 * It is the riskiest piece of the project (everything else is UI on top of its output),
 * which is why it is built first and with tests against fixtures that reproduce the real
 * structure observed in `~/.claude/projects/`:
 *
 *   - Each line is a JSON object with a `type` field.
 *   - Relevant types: `user`, `assistant`, `ai-title`. (Others: mode, attachment,
 *     system, file-history-snapshot… are ignored for the chat.)
 *   - `message.content` can be a string or an array of blocks:
 *       text | thinking | tool_use | tool_result | image
 *   - Events with `isSidechain: true` belong to subagents → excluded from the thread.
 *   - `user` events that are tool results (`tool_result` blocks or a `toolUseResult`
 *     field) are NOT human messages → excluded.
 *   - `cwd`, `gitBranch`, `timestamp` live at the root of the event.
 *   - The `recap:` appears as text, in both `user` and `assistant` events.
 *
 * Defensive design: any non-JSON line or unexpected event is counted in
 * `stats.skipped` and does not break parsing. The format may change between Claude Code
 * versions; when in doubt, the line is discarded, never thrown.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ChatMessage, LastSignal, ParsedSession, Recap, Role } from './types';

/**
 * Recap marker. The native Claude Code recap is stored as a line
 * `※ recap: …` (reference mark ※ U+203B or ✳ U+2733, followed by `recap:`).
 * We anchor to the start of the line and tolerate the symbols/bullets preceding it
 * (`※ ✳ * > -` and spaces). This way we catch the real recap and the `**Recap:**` in markdown,
 * but not a `"recap:"` quoted mid-sentence.
 */
const RECAP_RE = /(^|\n)[ \t>*\-✳※]*recap:[ \t]*/i;

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
}

/** Extracts visible text, reasoning and tools from a `message.content`. */
function extractContent(content: unknown): {
  text: string;
  thinking: string;
  tools: string[];
  isToolResult: boolean;
} {
  if (typeof content === 'string') {
    return { text: content, thinking: '', tools: [], isToolResult: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', thinking: '', tools: [], isToolResult: false };
  }
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const tools: string[] = [];
  let isToolResult = false;
  for (const raw of content) {
    const block = raw as ContentBlock;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') textParts.push(block.text);
        break;
      case 'thinking':
        if (typeof block.text === 'string') thinkingParts.push(block.text);
        break;
      case 'tool_use':
        if (typeof block.name === 'string') tools.push(block.name);
        break;
      case 'tool_result':
        isToolResult = true;
        break;
      default:
        break;
    }
  }
  return {
    text: textParts.join('\n').trim(),
    thinking: thinkingParts.join('\n').trim(),
    tools,
    isToolResult,
  };
}

/** Extracts the recap text from the marker to the end of the block. */
function extractRecap(text: string): string | null {
  const m = RECAP_RE.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  // Clean up markdown/symbol residue right after the marker (e.g. `**Recap:**`).
  const out = text.slice(start).replace(/^[*:>\s]+/, '').trim();
  return out || null;
}

/**
 * Parses the complete content of a transcript.
 * @param content text of the `.jsonl`
 * @param sessionIdFallback sessionId to use if no event declares it (e.g. the file name)
 */
export function parseTranscript(content: string, sessionIdFallback: string | null = null): ParsedSession {
  const messages: ChatMessage[] = [];
  const recaps: Recap[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let title: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let lastSignal: LastSignal | null = null;
  let lines = 0;
  let skipped = 0;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    lines++;

    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }

    if (typeof ev.sessionId === 'string' && !sessionId) sessionId = ev.sessionId;
    if (typeof ev.cwd === 'string' && !cwd) cwd = ev.cwd;
    if (typeof ev.gitBranch === 'string' && !gitBranch) gitBranch = ev.gitBranch;

    const ts = typeof ev.timestamp === 'string' ? ev.timestamp : null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    const type = ev.type;

    if (type === 'ai-title') {
      if (typeof ev.aiTitle === 'string' && ev.aiTitle.trim()) title = ev.aiTitle.trim();
      continue;
    }

    if (type !== 'user' && type !== 'assistant') {
      continue; // mode, attachment, system, snapshots… are not chat
    }

    if (ev.isSidechain === true) {
      skipped++; // subagent: outside the main thread
      continue;
    }

    const message = ev.message as { content?: unknown; role?: unknown; stop_reason?: unknown } | undefined;
    const { text, thinking, tools, isToolResult } = extractContent(message?.content);
    const isUserToolResult = type === 'user' && (isToolResult || 'toolUseResult' in ev);

    // Tail signal: classifies THIS raw event (whether or not it is a visible chat turn) to
    // deduce the live state. It is overwritten on each event → at the end = the last one.
    const stopReason = typeof message?.stop_reason === 'string' ? message.stop_reason : null;
    if (type === 'assistant') {
      lastSignal = { kind: tools.length > 0 ? 'tool_use' : 'assistant-message', ts, stopReason };
    } else {
      lastSignal = { kind: isUserToolResult ? 'tool_result' : 'user-message', ts, stopReason: null };
    }

    // `user` events that are tool results are not human messages.
    if (isUserToolResult) {
      skipped++;
      continue;
    }

    // Nothing to show (e.g. user with only an image and no text) → adds nothing to the chat.
    if (!text && !thinking && tools.length === 0) {
      skipped++;
      continue;
    }

    const role: Role = type === 'assistant' ? 'assistant' : 'user';
    const meta = ev.isMeta === true;
    const msg: ChatMessage = { role, ts, text, thinking, tools, meta };
    messages.push(msg);

    const recapText = extractRecap(text);
    if (recapText) {
      recaps.push({ text: recapText, ts, messageIndex: messages.length - 1 });
    }
  }

  return {
    sessionId: sessionId ?? sessionIdFallback,
    cwd,
    gitBranch,
    title,
    messages,
    recaps,
    firstTs,
    lastTs,
    lastSignal,
    stats: { lines, skipped },
  };
}

/** Parses a transcript from disk. The default sessionId is the file name. */
export function parseTranscriptFile(path: string): ParsedSession {
  const content = readFileSync(path, 'utf8');
  const fallbackId = basename(path).replace(/\.jsonl$/i, '');
  return parseTranscript(content, fallbackId);
}
