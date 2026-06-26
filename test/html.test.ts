import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTranscriptFile } from '../src/parser';
import { escapeHtml, renderChatBody, renderChatDocument } from '../src/ui/html';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => join(here, 'fixtures', n);

describe('escapeHtml', () => {
  it('neutralizes dangerous HTML', () => {
    expect(escapeHtml('<script>"x"&\'y\'')).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
  });
});

describe('renderChatBody', () => {
  const detail = parseTranscriptFile(fixture('basic.jsonl'));
  const body = renderChatBody(detail);

  it('shows message text (escaped)', () => {
    expect(body).toContain('arregla el tracking de visitas');
  });

  it('highlights recaps with chip and badge', () => {
    expect(body).toContain('recap-chip');
    expect(body).toContain('★ recap');
  });

  it('includes collapsible thinking and tool badges', () => {
    expect(body).toContain('class="fold thinking"');
    expect(body).toContain('pienso en la causa');
    expect(body).toContain('>Edit<');
  });
});

describe('renderChatDocument', () => {
  const detail = parseTranscriptFile(fixture('basic.jsonl'));
  const doc = renderChatDocument(detail, {
    nonce: 'NONCE123',
    cspSource: 'vscode-resource:',
    title: 'Arreglar heatmap',
    projectName: '/Users/x/proj',
    resumeId: 'sess-basic',
    cwd: '/Users/x/proj',
  });

  it('is a document with CSP and nonce', () => {
    expect(doc).toContain('<!DOCTYPE html>');
    expect(doc).toContain("script-src 'nonce-NONCE123'");
    expect(doc).toContain('id="resume"');
  });

  it('offers a full-permissions button (--dangerously-skip-permissions)', () => {
    expect(doc).toContain('id="resumeFull"');
    expect(doc).toContain('--dangerously-skip-permissions');
  });

  it('disables resume when there is no sessionId', () => {
    const d2 = renderChatDocument(detail, {
      nonce: 'N',
      cspSource: '',
      title: 't',
      projectName: 'p',
      resumeId: null,
      cwd: null,
    });
    expect(d2).toContain('disabled');
  });
});
