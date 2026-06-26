/**
 * Build a read-only digest of several sessions from their recap checkpoints, to seed a new
 * session. Pure and deterministic — no LLM: we just consolidate the `recap:` lines the parser
 * already extracts. The user can edit the result freely before using it.
 */

export interface ThreadDigest {
  label: string;
  project?: string;
  ts?: string | null;
  recaps: { text: string }[];
}

export function buildThreadSummary(threads: ThreadDigest[]): string {
  const parts: string[] = [
    `# Summary of ${threads.length} thread(s)`,
    '',
    '> Consolidated by Laia Agent Router from recap checkpoints. Read-only digest — edit freely.',
    '',
  ];
  for (const t of threads) {
    const heading = t.project ? `## ${t.label} — ${t.project}` : `## ${t.label}`;
    parts.push(heading);
    if (t.ts) parts.push(`*Last activity: ${t.ts}*`, '');
    if (t.recaps.length) {
      for (const r of t.recaps) parts.push(`- ${r.text}`);
    } else {
      parts.push('- _(no recaps captured)_');
    }
    parts.push('');
  }
  return parts.join('\n');
}
