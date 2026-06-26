import { describe, it, expect } from 'vitest';
import { buildThreadSummary, type ThreadDigest } from '../src/core/summary';

const threads: ThreadDigest[] = [
  {
    label: 'Fix visit tracking',
    project: '/Users/x/web',
    ts: '2026-06-24T10:00:00Z',
    recaps: [{ text: 'Goal: make tracking reliable' }, { text: 'Deployed and verified' }],
  },
  { label: 'Empty thread', recaps: [] },
];

describe('buildThreadSummary', () => {
  it('mentions how many threads were summarized', () => {
    expect(buildThreadSummary(threads)).toContain('2');
  });

  it('adds a heading per thread with its label', () => {
    const md = buildThreadSummary(threads);
    expect(md).toContain('## Fix visit tracking');
    expect(md).toContain('## Empty thread');
  });

  it('lists each recap as a bullet', () => {
    const md = buildThreadSummary(threads);
    expect(md).toContain('- Goal: make tracking reliable');
    expect(md).toContain('- Deployed and verified');
  });

  it('notes when a thread has no recaps', () => {
    const md = buildThreadSummary(threads);
    expect(md.toLowerCase()).toContain('no recaps');
  });

  it('includes the project when present', () => {
    expect(buildThreadSummary(threads)).toContain('/Users/x/web');
  });
});
