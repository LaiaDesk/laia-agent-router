import { describe, it, expect } from 'vitest';
import { resolveProjectPath, projectTemplate } from '../src/core/newProject';

describe('resolveProjectPath', () => {
  const home = '/Users/ana';

  it('leaves an absolute path intact', () => {
    expect(resolveProjectPath('/srv/proyectos/web', home)).toBe('/srv/proyectos/web');
  });

  it('expands ~ to home', () => {
    expect(resolveProjectPath('~/code/web', home)).toBe('/Users/ana/code/web');
  });

  it('expands a bare ~ to home', () => {
    expect(resolveProjectPath('~', home)).toBe('/Users/ana');
  });

  it('resolves a relative path against home', () => {
    expect(resolveProjectPath('code/web', home)).toBe('/Users/ana/code/web');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveProjectPath('  /srv/web  ', home)).toBe('/srv/web');
  });

  it('normalizes trailing slashes and redundant segments', () => {
    expect(resolveProjectPath('/srv/web/', home)).toBe('/srv/web');
    expect(resolveProjectPath('/srv/./web', home)).toBe('/srv/web');
  });
});

describe('projectTemplate', () => {
  it('includes the 7 durable sections as headers (English by default)', () => {
    const md = projectTemplate('mi-proyecto');
    for (const h of [
      '## What it is / Context',
      '## Tone and style',
      '## Background and references',
      '## Goals and rules',
      '## Examples',
      '## Right now / next step',
      '## Expected output format',
    ]) {
      expect(md).toContain(h);
    }
  });

  it('substitutes the project name in the title and leaves no placeholder', () => {
    const md = projectTemplate('mi-proyecto');
    expect(md).toContain('# mi-proyecto — Project north star');
    expect(md).not.toContain('<NombreProyecto>');
  });

  it('applies the injected translation function to each text', () => {
    const md = projectTemplate('x', (s) => `[${s}]`);
    expect(md).toContain('# x — [Project north star]');
    expect(md).toContain('## [What it is / Context]');
  });
});
