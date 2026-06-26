/**
 * Cross-cutting views over the catalog: recaps timeline and global search.
 * Both parse lazily (via details) and traverse already-filtered projects.
 */

import type { ProjectEntry } from './catalog';
import { getDetail, sessionLabel } from './details';

export interface RecapEntry {
  text: string;
  ts: string | null;
  projectKey: string;
  projectName: string;
  sessionId: string;
  sessionLabel: string;
  path: string;
  messageIndex: number;
}

export interface SearchHit {
  projectKey: string;
  projectName: string;
  sessionId: string;
  sessionLabel: string;
  path: string;
  role: 'user' | 'assistant';
  messageIndex: number;
  snippet: string;
}

/** Traverses the sessions and returns their recaps ordered by date (most recent first). */
export function collectRecaps(projects: ProjectEntry[]): RecapEntry[] {
  const out: RecapEntry[] = [];
  for (const p of projects) {
    for (const s of p.sessions) {
      let detail;
      try {
        detail = getDetail(s.path);
      } catch {
        continue;
      }
      const label = sessionLabel(detail, s.id);
      for (const r of detail.recaps) {
        out.push({
          text: r.text,
          ts: r.ts,
          projectKey: p.key,
          projectName: p.displayName,
          sessionId: s.id,
          sessionLabel: label,
          path: s.path,
          messageIndex: r.messageIndex,
        });
      }
    }
  }
  out.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  return out;
}

function snippetAround(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  const clean = text.replace(/\s+/g, ' ').trim();
  if (idx < 0) return clean.slice(0, 120);
  const cleanIdx = clean.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, cleanIdx - 40);
  return (start > 0 ? '…' : '') + clean.slice(start, cleanIdx + query.length + 60) + '…';
}

/** Searches text in messages (you and Claude) across all the given projects. */
export function search(projects: ProjectEntry[], query: string, max = 200): SearchHit[] {
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  if (!q) return hits;
  for (const p of projects) {
    for (const s of p.sessions) {
      let detail;
      try {
        detail = getDetail(s.path);
      } catch {
        continue;
      }
      const label = sessionLabel(detail, s.id);
      for (let i = 0; i < detail.messages.length; i++) {
        const m = detail.messages[i]!;
        if (m.text.toLowerCase().includes(q)) {
          hits.push({
            projectKey: p.key,
            projectName: p.displayName,
            sessionId: s.id,
            sessionLabel: label,
            path: s.path,
            role: m.role,
            messageIndex: i,
            snippet: snippetAround(m.text, q),
          });
          if (hits.length >= max) return hits;
        }
      }
    }
  }
  return hits;
}
