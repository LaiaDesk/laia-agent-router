/**
 * Manual smoke test against the REAL transcripts in `~/.claude/projects/`.
 *
 * It is not an automated test (it depends on your machine and on private data that is
 * NOT committed). It is used to validate that the parser holds up against the real format at scale.
 *
 *   npm run smoke               # summary of all projects
 *   npm run smoke -- <substr>   # only projects whose path contains <substr>
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscriptFile } from '../src/parser';

const ROOT = join(homedir(), '.claude', 'projects');
const filter = process.argv[2] ?? '';

let projects = 0;
let sessions = 0;
let recaps = 0;
let withTitle = 0;
let withCwd = 0;
let errors = 0;

for (const project of readdirSync(ROOT)) {
  if (filter && !project.includes(filter)) continue;
  const dir = join(ROOT, project);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    continue;
  }
  if (files.length === 0) continue;
  projects++;
  let projRecaps = 0;
  for (const f of files) {
    const path = join(dir, f);
    try {
      if (!statSync(path).isFile()) continue;
      const s = parseTranscriptFile(path);
      sessions++;
      recaps += s.recaps.length;
      projRecaps += s.recaps.length;
      if (s.title) withTitle++;
      if (s.cwd) withCwd++;
    } catch (err) {
      errors++;
      console.error(`  ✗ ${f}: ${(err as Error).message}`);
    }
  }
  console.log(`▸ ${project}  (${files.length} sesiones, ${projRecaps} recaps)`);
}

console.log('\n=== SUMMARY ===');
console.log(`projects: ${projects}`);
console.log(`sessions:  ${sessions}`);
console.log(`recaps:    ${recaps}`);
console.log(`with ai-title: ${withTitle}/${sessions}`);
console.log(`con cwd interno:     ${withCwd}/${sessions}`);
console.log(`errores de parseo:   ${errors}`);
