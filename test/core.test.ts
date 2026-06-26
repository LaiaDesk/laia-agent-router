import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MetaStore } from '../src/core/store';
import { listProjects, isTempProject } from '../src/core/catalog';
import { collectRecaps, search } from '../src/core/insights';
import { clearDetailCache } from '../src/core/details';

const here = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

describe('MetaStore', () => {
  let path: string;
  beforeAll(() => {
    path = join(mkdtempSync(join(tmpdir(), 'laia-store-')), 'store.json');
  });

  it('persists label/archived/hidden across instances', () => {
    const a = new MetaStore(path);
    a.setLabel('s1', 'Mi tema');
    a.setArchived('s1', true);
    a.setHidden('s2', true);

    const b = new MetaStore(path); // re-reads from disk
    expect(b.get('s1').label).toBe('Mi tema');
    expect(b.get('s1').archived).toBe(true);
    expect(b.get('s2').hidden).toBe(true);
  });

  it('clears empty metadata', () => {
    const s = new MetaStore(path);
    s.setArchived('s1', false);
    s.setLabel('s1', '');
    expect(s.get('s1').archived).toBeUndefined();
    expect(s.get('s1').label).toBeUndefined();
  });
});

describe('catalog.listProjects', () => {
  let root: string;
  beforeAll(() => {
    clearDetailCache();
    root = mkdtempSync(join(tmpdir(), 'laia-root-'));
    const projA = join(root, '-Users-x-projA');
    const temp = join(root, '-private-tmp-scratch');
    mkdirSync(projA, { recursive: true });
    mkdirSync(temp, { recursive: true });
    writeFileSync(join(projA, 'real-recap.jsonl'), readFixture('real-recap.jsonl'));
    writeFileSync(join(temp, 'basic.jsonl'), readFixture('basic.jsonl'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('excludes temporary projects by default', () => {
    expect(isTempProject('-private-tmp-scratch')).toBe(true);
    const ps = listProjects(root);
    expect(ps.map((p) => p.key)).toEqual(['-Users-x-projA']);
    expect(ps[0]!.sessions).toHaveLength(1);
  });

  it('includes them with includeTemp', () => {
    const ps = listProjects(root, { includeTemp: true });
    expect(ps.map((p) => p.key).sort()).toEqual(['-Users-x-projA', '-private-tmp-scratch']);
  });
});

describe('insights — recaps and search', () => {
  let root: string;
  beforeAll(() => {
    clearDetailCache();
    root = mkdtempSync(join(tmpdir(), 'laia-ins-'));
    const proj = join(root, '-Users-x-projA');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'real-recap.jsonl'), readFixture('real-recap.jsonl'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('aggregates recaps from the project sessions', () => {
    const recaps = collectRecaps(listProjects(root));
    expect(recaps.length).toBeGreaterThanOrEqual(2);
    expect(recaps.some((r) => r.text.includes('Meeting-IA'))).toBe(true);
    expect(recaps[0]!.projectKey).toBe('-Users-x-projA');
  });

  it('searches text in human and assistant messages', () => {
    const hits = search(listProjects(root), 'robusto');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.role).toBe('user');
    expect(hits[0]!.snippet.toLowerCase()).toContain('robusto');
  });

  it('empty search returns nothing', () => {
    expect(search(listProjects(root), '   ')).toHaveLength(0);
  });
});
