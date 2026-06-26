/**
 * Pure core of "Add project": path resolution and the PROJECT.md template.
 * Without touching disk or the VS Code API, so it can be tested with vitest.
 */

import { isAbsolute, join, normalize } from 'node:path';

/**
 * Normalizes the path the user types into an absolute path:
 * - trims whitespace
 * - expands `~` and `~/...` to the home directory
 * - resolves relative paths against the home directory
 * - collapses redundant segments and trailing slashes
 */
export function resolveProjectPath(input: string, home: string): string {
  const raw = input.trim();
  let abs: string;
  if (raw === '~') abs = home;
  else if (raw.startsWith('~/')) abs = join(home, raw.slice(2));
  else if (isAbsolute(raw)) abs = raw;
  else abs = join(home, raw);
  const norm = normalize(abs);
  // Removes the trailing slash except for the root "/".
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

/**
 * Returns the PROJECT.md (7-section template) with the name substituted in.
 * Base texts in English; `t` translates each string (defaults to identity → English).
 */
export function projectTemplate(name: string, t: (s: string) => string = (s) => s): string {
  return `# ${name} — ${t('Project north star')}

## ${t('What it is / Context')}
<!-- ${t('1. What this project is for and who it serves')} -->

## ${t('Tone and style')}
<!-- ${t('2. How it should communicate')} -->

## ${t('Background and references')}
<!-- ${t('3. Docs, links, key resources')} -->

## ${t('Goals and rules')}
<!-- ${t('4. Goals + inviolable rules. Think step by step.')} -->

## ${t('Examples')}
<!-- ${t('5. Examples of desired interaction/output')} -->

## ${t('Right now / next step')}
<!-- ${t('7. Current focus')} -->

## ${t('Expected output format')}
<!-- ${t('9. How to deliver results')} -->
`;
}
