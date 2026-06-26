/**
 * Renders the chat to HTML. The body-building functions are PURE (no vscode)
 * so they can be tested; the full document adds the CSP header + the webview script.
 */

import type { ChatMessage, ParsedSession } from '../types';

/** Translatable labels of the chat viewer. They are injected from the extension (vscode.l10n);
 *  the default English values keep `html.ts` pure and testable without `vscode`. */
export interface ChatStrings {
  you: string;
  system: string;
  thought: string;
  noMessages: string;
  messages: string;
  recaps: string;
  resume: string;
  resumeInTitle: string;
  fullPerms: string;
  fullPermsTitle: string;
  resumeUnavailable: string;
}

export const CHAT_STRINGS_EN: ChatStrings = {
  you: 'You',
  system: 'System',
  thought: 'thought',
  noMessages: 'No messages.',
  messages: 'messages',
  recaps: 'recaps',
  resume: 'Resume ⏎',
  resumeInTitle: 'claude --resume in',
  fullPerms: '⚡ Full permissions',
  fullPermsTitle: 'claude --resume --dangerously-skip-permissions (without asking for permissions)',
  resumeUnavailable: 'Resume unavailable',
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMessage(m: ChatMessage, isRecap: boolean, s: ChatStrings): string {
  const who = m.role === 'assistant' ? 'Claude' : m.meta ? s.system : s.you;
  const cls = `msg ${m.role}${m.meta ? ' meta' : ''}`;
  const parts: string[] = [];

  if (m.thinking) {
    parts.push(
      `<details class="fold thinking"><summary>▸ ${escapeHtml(s.thought)}</summary><pre>${escapeHtml(m.thinking)}</pre></details>`,
    );
  }
  if (m.tools.length) {
    const tools = m.tools.map((t) => `<span class="tool">${escapeHtml(t)}</span>`).join('');
    parts.push(`<div class="tools">${tools}</div>`);
  }
  if (m.text) {
    parts.push(`<div class="text">${escapeHtml(m.text)}</div>`);
  }

  const badge = isRecap ? '<span class="recap-badge">★ recap</span>' : '';
  return `<div class="${cls}"><div class="who">${escapeHtml(who)}${badge}</div>${parts.join('')}</div>`;
}

/** Inner body of the chat (without <html>): testable. */
export function renderChatBody(detail: ParsedSession, s: ChatStrings = CHAT_STRINGS_EN): string {
  const recapIdx = new Set(detail.recaps.map((r) => r.messageIndex));

  const recapStrip = detail.recaps.length
    ? `<div class="recaps"><div class="recaps-title">★ ${escapeHtml(s.recaps)} (${detail.recaps.length})</div>${detail.recaps
        .map((r) => `<button class="recap-chip" data-idx="${r.messageIndex}">${escapeHtml(r.text.slice(0, 90))}</button>`)
        .join('')}</div>`
    : '';

  const messages = detail.messages.map((m, i) => renderMessage(m, recapIdx.has(i), s)).join('');

  return `${recapStrip}<div class="thread">${messages || `<p class="empty">${escapeHtml(s.noMessages)}</p>`}</div>`;
}

export interface ChatDocOptions {
  nonce: string;
  cspSource: string;
  title: string;
  projectName: string;
  /** sessionId to resume; if null, the button is disabled. */
  resumeId: string | null;
  cwd: string | null;
  /** Translated labels; English by default. */
  i18n?: ChatStrings;
  /** Language code for the <html lang> attribute; 'en' by default. */
  lang?: string;
}

/** Complete HTML document for the webview. */
export function renderChatDocument(detail: ParsedSession, opts: ChatDocOptions): string {
  const s = opts.i18n ?? CHAT_STRINGS_EN;
  const resumeBtn = opts.resumeId
    ? `<button id="resume" title="${escapeHtml(s.resumeInTitle)} ${escapeHtml(opts.cwd ?? '')}">${escapeHtml(s.resume)}</button>` +
      `<button id="resumeFull" class="warn" title="${escapeHtml(s.fullPermsTitle)}">${escapeHtml(s.fullPerms)}</button>`
    : `<button id="resume" disabled>${escapeHtml(s.resumeUnavailable)}</button>`;

  return `<!DOCTYPE html>
<html lang="${escapeHtml(opts.lang ?? 'en')}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${opts.nonce}';">
<style>
  :root { color-scheme: dark light; }
  body { font: 13px/1.55 -apple-system, system-ui, sans-serif; margin: 0; padding: 0 0 40px; color: var(--vscode-foreground); }
  header { position: sticky; top: 0; backdrop-filter: blur(8px); background: var(--vscode-editor-background); padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 12px; }
  header .meta { flex: 1; min-width: 0; }
  header h1 { font-size: 14px; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .sub { font-size: 11px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { font: inherit; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 6px; padding: 6px 12px; }
  button[disabled] { opacity: .5; cursor: default; }
  button.warn { background: var(--vscode-inputValidation-warningBackground, #6b4e00); color: var(--vscode-foreground); border-color: var(--vscode-inputValidation-warningBorder, #b8860b); }
  .recaps { padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); }
  .recaps-title { font-size: 11px; letter-spacing: .04em; opacity: .7; width: 100%; }
  .recap-chip { background: var(--vscode-inputValidation-warningBackground, #4a3b00); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 4px 10px; max-width: 100%; text-align: left; }
  .thread { padding: 16px; display: flex; flex-direction: column; gap: 14px; max-width: 860px; margin: 0 auto; }
  .msg { border-radius: 10px; padding: 10px 12px; }
  .msg.user { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-panel-border); }
  .msg.assistant { background: transparent; border: 1px solid var(--vscode-panel-border); }
  .msg.meta { opacity: .6; font-style: italic; }
  .who { font-size: 11px; font-weight: 600; opacity: .7; margin-bottom: 4px; display: flex; gap: 8px; align-items: center; }
  .recap-badge { color: #f0b400; font-weight: 700; }
  .text { white-space: pre-wrap; word-break: break-word; }
  .fold { margin: 4px 0; }
  .fold summary { cursor: pointer; opacity: .6; font-size: 12px; }
  .fold pre { white-space: pre-wrap; opacity: .8; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 6px; }
  .tools { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
  .tool { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .empty { opacity: .5; }
</style>
</head>
<body>
<header>
  <div class="meta">
    <h1>${escapeHtml(opts.title)}</h1>
    <div class="sub">${escapeHtml(opts.projectName)} · ${detail.messages.length} ${escapeHtml(s.messages)} · ${detail.recaps.length} ${escapeHtml(s.recaps)}</div>
  </div>
  ${resumeBtn}
</header>
${renderChatBody(detail)}
<script nonce="${opts.nonce}">
  const vscode = acquireVsCodeApi();
  const resume = document.getElementById('resume');
  if (resume && !resume.disabled) resume.addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
  const resumeFull = document.getElementById('resumeFull');
  if (resumeFull) resumeFull.addEventListener('click', () => vscode.postMessage({ type: 'resumeFull' }));
  document.querySelectorAll('.recap-chip').forEach((c) => c.addEventListener('click', () => {
    const idx = c.getAttribute('data-idx');
    const el = document.querySelectorAll('.thread .msg')[Number(idx)];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  // Section C: on open, jump to the end — where Claude was left waiting (your turn) or got blocked.
  window.scrollTo(0, document.body.scrollHeight);
</script>
</body>
</html>`;
}
