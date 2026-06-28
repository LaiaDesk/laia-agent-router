/**
 * Pure helpers for the "open terminal" marker shown on session nodes.
 *
 * The VS Code layer gives each session node a `resourceUri` under our own scheme so a
 * FileDecorationProvider can paint a small badge on the sessions that currently have a terminal
 * open. The URI <-> id mapping and the badge decision live here so they are testable without vscode.
 */

export const SESSION_URI_SCHEME = 'laia-session';

/** Path part of the resourceUri for a session node (`laia-session:/<id>`). */
export function sessionUriPath(sessionId: string): string {
  return '/' + sessionId;
}

/** Extract the session id from a resourceUri's scheme+path; null if it isn't one of ours. */
export function sessionIdFromUri(scheme: string, path: string): string | null {
  if (scheme !== SESSION_URI_SCHEME) return null;
  const id = path.replace(/^\/+/, '');
  return id.length ? id : null;
}

export interface OpenDecoration {
  badge: string;
  tooltip: string;
}

/** Decoration for a session with an open terminal; undefined when no terminal is open. */
export function openDecoration(isOpen: boolean): OpenDecoration | undefined {
  return isOpen ? { badge: '●', tooltip: 'Open terminal' } : undefined;
}
