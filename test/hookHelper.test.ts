import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, '..', 'assets', 'hook-signal.mjs');

// Runs the real helper script with the given event JSON on stdin, signals written to `dir`.
function run(dir: string, payload: object): void {
  execFileSync('node', [helper], {
    input: JSON.stringify(payload),
    env: { ...process.env, LAIA_SIGNALS_DIR: dir },
  });
}

describe('hook-signal.mjs (real script)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'laia-sig-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a per-session signal for a Stop event', () => {
    run(dir, { hook_event_name: 'Stop', session_id: 'sess-1' });
    const file = join(dir, 'sess-1.json');
    expect(existsSync(file)).toBe(true);
    const sig = JSON.parse(readFileSync(file, 'utf8'));
    expect(sig.kind).toBe('awaiting');
    expect(typeof sig.ts).toBe('number');
  });

  it('maps a permission_prompt notification to blocked', () => {
    run(dir, { hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: 's2' });
    const sig = JSON.parse(readFileSync(join(dir, 's2.json'), 'utf8'));
    expect(sig.kind).toBe('blocked');
  });

  it('writes nothing for an untracked event', () => {
    run(dir, { hook_event_name: 'SessionStart', session_id: 's3' });
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('never throws on garbage stdin', () => {
    expect(() => run(dir, 'garbage' as unknown as object)).not.toThrow();
  });
});
