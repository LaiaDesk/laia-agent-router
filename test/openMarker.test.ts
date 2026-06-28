import { describe, it, expect } from 'vitest';
import {
  SESSION_URI_SCHEME,
  sessionUriPath,
  sessionIdFromUri,
  openDecoration,
} from '../src/core/openMarker';

describe('session resourceUri round-trip', () => {
  it('builds a path from a session id and parses it back', () => {
    const id = 'a1c4d03e-31ce-4438-86d1-1f7718fa6097';
    expect(sessionIdFromUri(SESSION_URI_SCHEME, sessionUriPath(id))).toBe(id);
  });

  it('ignores URIs from other schemes', () => {
    expect(sessionIdFromUri('file', '/a1c4')).toBeNull();
  });

  it('returns null for an empty path', () => {
    expect(sessionIdFromUri(SESSION_URI_SCHEME, '/')).toBeNull();
  });
});

describe('openDecoration', () => {
  it('marks open sessions with a dot badge', () => {
    expect(openDecoration(true)?.badge).toBe('●');
  });

  it('has a tooltip mentioning the terminal', () => {
    expect(openDecoration(true)?.tooltip.toLowerCase()).toContain('terminal');
  });

  it('returns nothing for closed sessions', () => {
    expect(openDecoration(false)).toBeUndefined();
  });
});
