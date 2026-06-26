import { describe, it, expect } from 'vitest';
import { mergeHookConfig, HOOK_EVENTS } from '../src/core/hookInstall';

const CMD = 'node ~/.laia-chats/hook-signal.mjs';

describe('mergeHookConfig', () => {
  it('adds our command for every tracked event on empty settings', () => {
    const out = mergeHookConfig({}, CMD);
    for (const event of HOOK_EVENTS) {
      const groups = out.hooks[event];
      expect(Array.isArray(groups)).toBe(true);
      const ours = groups.flatMap((g: any) => g.hooks).find((h: any) => h.command === CMD);
      expect(ours).toBeTruthy();
      expect(ours.type).toBe('command');
      expect(ours.async).toBe(true); // never slows the agent
    }
  });

  it('preserves unrelated top-level settings', () => {
    const out = mergeHookConfig({ permissions: { allow: ['Bash'] }, voiceEnabled: true }, CMD);
    expect(out.permissions).toEqual({ allow: ['Bash'] });
    expect(out.voiceEnabled).toBe(true);
  });

  it('preserves existing hooks on the same event (appends, not replaces)', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }],
      },
    };
    const out = mergeHookConfig(existing, CMD);
    const commands = out.hooks.PreToolUse.flatMap((g: any) => g.hooks).map((h: any) => h.command);
    expect(commands).toContain('my-linter'); // kept
    expect(commands).toContain(CMD); // added
  });

  it('is idempotent: merging twice does not duplicate our command', () => {
    const once = mergeHookConfig({}, CMD);
    const twice = mergeHookConfig(once, CMD);
    for (const event of HOOK_EVENTS) {
      const count = twice.hooks[event]
        .flatMap((g: any) => g.hooks)
        .filter((h: any) => h.command === CMD).length;
      expect(count).toBe(1);
    }
  });

  it('does not mutate the input object', () => {
    const input = { permissions: { allow: [] } };
    const snapshot = JSON.stringify(input);
    mergeHookConfig(input, CMD);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
