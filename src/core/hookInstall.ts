/**
 * F5 — Safe, idempotent merge of our live-signal hooks into a Claude Code settings object.
 *
 * Pure: takes the parsed settings and the helper command, returns a NEW settings object with our
 * hooks added. Never mutates the input, never removes the user's existing hooks or other settings.
 * The actual file read/write lives in the extension layer.
 */

/** Claude Code events we register the signal helper on. */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SessionEnd',
] as const;

interface HookCommand {
  type: 'command';
  command: string;
  async?: boolean;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** Returns a deep-ish clone with our hooks merged in for every tracked event. Idempotent. */
export function mergeHookConfig(settings: Record<string, any>, command: string): Record<string, any> {
  const out: Record<string, any> = structuredClone(settings ?? {});
  const hooks: Record<string, HookGroup[]> = out.hooks ?? {};
  out.hooks = hooks;

  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const alreadyOurs = groups.some((g) => g.hooks?.some((h) => h.command === command));
    if (!alreadyOurs) {
      // No matcher → fires for all tools / all notification types; the helper filters by event.
      groups.push({ hooks: [{ type: 'command', command, async: true }] });
    }
    hooks[event] = groups;
  }
  return out;
}
