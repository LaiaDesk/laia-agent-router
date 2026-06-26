#!/usr/bin/env node
/**
 * Laia Agent Router — Claude Code hook helper.
 *
 * Installed at ~/.laia-chats/hook-signal.mjs and registered as an (async) hook command for
 * UserPromptSubmit, PreToolUse, PostToolUse, Stop, Notification and SessionEnd. Claude Code pipes
 * the event JSON on stdin; we map it to a live-status "kind" and write a tiny per-session signal
 * file the extension watches. Always exits 0 and never blocks the agent.
 *
 * Keep the event→kind mapping in sync with src/core/liveSignal.ts (signalKindForEvent).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function kindFor(event, notificationType) {
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
      if (notificationType === 'idle_prompt') return 'awaiting';
      if (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog') return 'blocked';
      return null;
    default:
      return null;
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw || '{}');
    const kind = kindFor(ev.hook_event_name, ev.notification_type);
    if (kind && ev.session_id) {
      const dir = process.env.LAIA_SIGNALS_DIR || join(homedir(), '.laia-chats', 'signals');
      mkdirSync(dir, { recursive: true });
      const safeId = String(ev.session_id).replace(/[^A-Za-z0-9._-]/g, '_');
      writeFileSync(
        join(dir, safeId + '.json'),
        JSON.stringify({ kind, ts: Date.now(), event: ev.hook_event_name }),
      );
    }
  } catch {
    // never block the agent on a signal failure
  }
  process.exit(0);
});
