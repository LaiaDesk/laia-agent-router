/**
 * Lazy parsing with a cache keyed by (path, mtime). A session is only parsed when it is
 * needed (when opening it, or when traversing recaps/search) and is reused until the file
 * changes. Keeps the tree fast without parsing thousands of transcripts at once.
 */

import { statSync } from 'node:fs';
import { parseTranscriptFile } from '../parser';
import type { ParsedSession } from '../types';

const cache = new Map<string, { mtimeMs: number; data: ParsedSession }>();

export function getDetail(path: string): ParsedSession {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // file missing: parseTranscriptFile will throw and the caller decides
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  const data = parseTranscriptFile(path);
  cache.set(path, { mtimeMs, data });
  return data;
}

export function clearDetailCache(): void {
  cache.clear();
}

/** Readable label for a session: AI title → first human message → short id. */
export function sessionLabel(detail: ParsedSession, fallbackId: string): string {
  if (detail.title) return detail.title;
  const firstUser = detail.messages.find((m) => m.role === 'user' && !m.meta && m.text);
  if (firstUser) {
    const clean = firstUser.text.replace(/\s+/g, ' ').trim();
    return clean.length > 64 ? clean.slice(0, 64) + '…' : clean;
  }
  return fallbackId.slice(0, 8);
}
