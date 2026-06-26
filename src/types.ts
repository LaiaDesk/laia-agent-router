/**
 * Data model of a Claude Code session parsed from its `.jsonl` transcript.
 *
 * Source of truth: the `.jsonl` files in `~/.claude/projects/<project>/`. This parser is
 * READ ONLY; it never modifies the transcript. Everything derived (this object) can be
 * rebuilt at any time, so the SQLite index that caches it is disposable.
 */

export type Role = 'user' | 'assistant';

/** A visible chat turn (human message or assistant response). */
export interface ChatMessage {
  role: Role;
  /** ISO-8601 timestamp of the event, if present. */
  ts: string | null;
  /** Concatenated visible text (`text` blocks). */
  text: string;
  /** Concatenated reasoning (`thinking` blocks), assistant only. Collapsible in the UI. */
  thinking: string;
  /** Names of tools used in the turn (`tool_use` blocks). Collapsible in the UI. */
  tools: string[];
  /** true if it is an event injected by the system (isMeta), not a real human prompt. */
  meta: boolean;
}

/** A detected `recap:`: save point / checkpoint of the thread. */
export interface Recap {
  /** Recap text (what follows the `recap:` marker). */
  text: string;
  ts: string | null;
  /** Index within `messages[]` of the turn that contains the recap. */
  messageIndex: number;
}

/**
 * Classification of the LAST raw event (user/assistant, not sidechain) of the transcript.
 * It is the basis for deducing the live state (see `core/state.ts`):
 *  - `tool_use`        → the assistant called a tool and is waiting for its result (working / maybe blocked).
 *  - `tool_result`     → the result has just arrived; the assistant is about to respond (working).
 *  - `user-message`    → the human has just written; the assistant is about to respond (working).
 *  - `assistant-message` → the assistant finished its turn; the ball is in your court (your move), unless stop_reason is `tool_use`.
 */
export type LastEventKind = 'user-message' | 'tool_result' | 'assistant-message' | 'tool_use';

/** Tail signal: the last relevant event of the transcript, used to compute the live state. */
export interface LastSignal {
  kind: LastEventKind;
  ts: string | null;
  /** The assistant's `message.stop_reason` if present (`end_turn`, `tool_use`…). May be missing. */
  stopReason: string | null;
}

/** Result of parsing a complete transcript. */
export interface ParsedSession {
  /** sessionId (== file name without extension). Required for `claude --resume`. */
  sessionId: string | null;
  /**
   * The session's real working directory, read from INSIDE the transcript.
   * It is NOT decoded from the folder name (which is ambiguous: `_`, `/` and `-` collapse).
   */
  cwd: string | null;
  gitBranch: string | null;
  /** Auto-generated title (`ai-title` event), used as the topic label. */
  title: string | null;
  messages: ChatMessage[];
  recaps: Recap[];
  firstTs: string | null;
  lastTs: string | null;
  /** Last raw event of the thread (not sidechain), used to deduce the live state. */
  lastSignal: LastSignal | null;
  /** Parsing diagnostics (total lines vs discarded). */
  stats: { lines: number; skipped: number };
}
