/**
 * Store of our own metadata (label, archived, hidden) per session.
 *
 * It is the ONLY thing we write. It lives in `~/.laia-chats/store.json` and is disposable:
 * if deleted, nothing of the history is lost (the `.jsonl` files are the source of truth).
 * That is why we don't use a native DB — a JSON is enough and never breaks loading the extension.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionMeta {
  label?: string;
  archived?: boolean;
  /** Hidden from the panel (soft delete); the `.jsonl` remains intact. */
  hidden?: boolean;
  /** Muted until this epoch-ms: not counted in the badge nor blinking while snoozed. */
  snoozedUntil?: number;
}

interface StoreData {
  sessions: Record<string, SessionMeta>;
  settings: { showArchived: boolean };
}

const EMPTY: StoreData = { sessions: {}, settings: { showArchived: false } };

export class MetaStore {
  private data: StoreData;

  constructor(private readonly path: string) {
    this.data = this.read();
  }

  private read(): StoreData {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreData>;
      return {
        sessions: parsed.sessions ?? {},
        settings: { showArchived: parsed.settings?.showArchived ?? false },
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  private mutate(id: string, patch: Partial<SessionMeta>): void {
    const current = this.data.sessions[id] ?? {};
    const next: SessionMeta = { ...current, ...patch };
    // Clean up falsy keys to avoid accumulating junk.
    if (!next.label) delete next.label;
    if (!next.archived) delete next.archived;
    if (!next.hidden) delete next.hidden;
    if (!next.snoozedUntil) delete next.snoozedUntil;
    if (Object.keys(next).length === 0) delete this.data.sessions[id];
    else this.data.sessions[id] = next;
    this.persist();
  }

  get(id: string): SessionMeta {
    return this.data.sessions[id] ?? {};
  }

  setLabel(id: string, label: string | undefined): void {
    this.mutate(id, { label: label?.trim() || undefined });
  }

  setArchived(id: string, archived: boolean): void {
    this.mutate(id, { archived });
  }

  setHidden(id: string, hidden: boolean): void {
    this.mutate(id, { hidden });
  }

  /** Mute a session until `until` (epoch ms), or clear the snooze with `undefined`. */
  setSnoozedUntil(id: string, until: number | undefined): void {
    this.mutate(id, { snoozedUntil: until });
  }

  get showArchived(): boolean {
    return this.data.settings.showArchived;
  }

  setShowArchived(value: boolean): void {
    this.data.settings.showArchived = value;
    this.persist();
  }
}
