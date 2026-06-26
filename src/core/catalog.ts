/**
 * Catalog of projects and sessions read from `~/.claude/projects/`.
 *
 * Cheap on purpose: it only lists files and reads their `stat` (mtime/size). The expensive
 * details (parsing the `.jsonl`) are done lazily in `details.ts`. This way the tree opens
 * instantly even with thousands of sessions.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface SessionEntry {
  id: string; // sessionId == file name without .jsonl
  path: string;
  projectKey: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface ProjectEntry {
  key: string; // encoded folder name
  dir: string;
  displayName: string; // readable approximation (the exact cwd comes from parsing)
  sessions: SessionEntry[];
  lastActivityMs: number;
}

/** Temporary/scratch folders that by default are not of interest in the panel. */
const TEMP_PREFIXES = ['-private-tmp', '-private-var-folders', '-tmp', '-var-folders', '-T-'];

export function defaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

export function isTempProject(key: string): boolean {
  return TEMP_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Approximate readable project name from the folder name. It is AMBIGUOUS
 * (`_`, `/` and `-` collapse to `-`), so it is only for display; the real cwd for
 * resuming is read from the transcript (see parser).
 */
export function decodeProjectDisplay(key: string): string {
  const body = key.replace(/^-/, '').replace(/-/g, '/');
  return '/' + body;
}

export function listProjects(root: string, opts: { includeTemp?: boolean } = {}): ProjectEntry[] {
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }

  const projects: ProjectEntry[] = [];
  for (const key of dirs) {
    if (!opts.includeTemp && isTempProject(key)) continue;
    const dir = join(root, key);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const sessions: SessionEntry[] = [];
    for (const f of files) {
      const path = join(dir, f);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        sessions.push({
          id: basename(f, '.jsonl'),
          path,
          projectKey: key,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        });
      } catch {
        // file vanished between readdir and stat: ignore
      }
    }
    if (sessions.length === 0) continue;
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    projects.push({
      key,
      dir,
      displayName: decodeProjectDisplay(key),
      sessions,
      lastActivityMs: sessions[0]!.mtimeMs,
    });
  }
  projects.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return projects;
}
