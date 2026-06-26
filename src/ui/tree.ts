/**
 * TreeDataProvider: Project → Topics (sessions). Reads the cheap catalog and, per session,
 * resolves label/recaps and LIVE STATE lazily (cached). Applies the store filters
 * (hidden/archived).
 *
 * F4 — Live state signal:
 *   🟢 working  → icon that SPINS (native `sync~spin` animation).
 *   🟡 awaiting → dot that BLINKS subtly in amber (toggles filled/outline every ~1s).
 *   🔴 blocked  → dot that BLINKS subtly in red.
 *   ⚪ idle/archived → fixed, no animation.
 * The session you have OPEN does not animate (focus rule): you don't notify yourself about where you already are.
 *
 * Efficiency: the states of all sessions are computed in a SINGLE pass per tick
 * (`recomputeStates`), prefiltering by mtime (the dormant ones are not parsed) and caching the
 * result so getChildren/getTreeItem do not repeat I/O. The blink refreshes ONLY the
 * nodes that blink, not the whole tree; only a real state transition re-sorts the tree.
 */

import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { ProjectEntry, SessionEntry } from '../core/catalog';
import { defaultProjectsRoot, listProjects } from '../core/catalog';
import { getDetail, sessionLabel } from '../core/details';
import type { HookSignal } from '../core/liveSignal';
import type { MetaStore } from '../core/store';
import {
  liveScan,
  liveStateOf,
  needsAttention,
  statePriority,
  type AttentionCount,
  type SessionState,
  type StateThresholds,
} from '../core/state';

export type TreeNode =
  | { kind: 'project'; project: ProjectEntry }
  | { kind: 'session'; session: SessionEntry; project: ProjectEntry };

/** Cadence of the blink and of the time-based state recomputation (working→blocked→idle transitions). */
const TICK_MS = 1000;

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return vscode.l10n.t('now');
  if (min < 60) return vscode.l10n.t('{0}m ago', min);
  const h = Math.round(min / 60);
  if (h < 24) return vscode.l10n.t('{0}h ago', h);
  const d = Math.round(h / 24);
  return vscode.l10n.t('{0}d ago', d);
}

function fmtDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(vscode.env.language || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

function projectShortName(project: ProjectEntry): string {
  const newest = project.sessions[0];
  if (newest) {
    try {
      const cwd = getDetail(newest.path).cwd;
      if (cwd) return basename(cwd);
    } catch {
      /* fallback below */
    }
  }
  return basename(project.displayName) || project.key;
}

/** Translated state label (function, not const: vscode.l10n must be resolved at runtime). */
function stateLabel(state: SessionState): string {
  switch (state) {
    case 'working':
      return vscode.l10n.t('working');
    case 'awaiting':
      return vscode.l10n.t('your turn');
    case 'blocked':
      return vscode.l10n.t('blocked');
    case 'idle':
      return vscode.l10n.t('idle');
  }
}

/**
 * Icon based on state. `blinkOn` toggles the blink frame (filled/outline). `frozen`
 * (open session) freezes the animation: shows the fixed state, without spinning or blinking.
 */
function iconFor(state: SessionState, blinkOn: boolean, frozen: boolean, archived: boolean): vscode.ThemeIcon {
  if (archived) return new vscode.ThemeIcon('archive');
  const yellow = new vscode.ThemeColor('charts.yellow');
  const red = new vscode.ThemeColor('charts.red');
  const green = new vscode.ThemeColor('charts.green');
  switch (state) {
    case 'working':
      // Native spin (animates on its own). Frozen: a fixed gear.
      return new vscode.ThemeIcon(frozen ? 'gear' : 'sync~spin', green);
    case 'awaiting':
      return new vscode.ThemeIcon(frozen || blinkOn ? 'circle-filled' : 'circle-outline', yellow);
    case 'blocked':
      return new vscode.ThemeIcon(frozen || blinkOn ? 'circle-filled' : 'circle-outline', red);
    case 'idle':
      return new vscode.ThemeIcon('circle-outline');
  }
}

function sameCount(a: AttentionCount, b: AttentionCount): boolean {
  return a.awaiting === b.awaiting && a.blocked === b.blocked && a.total === b.total;
}

export class SessionsTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private projects: ProjectEntry[] = [];
  private blinkOn = true;
  private openSessionId: string | null = null;
  private lastAttention: AttentionCount = { awaiting: 0, blocked: 0, total: 0 };
  /** State computed per session in the last pass (key: sessionId). Avoids recomputing I/O. */
  private stateCache = new Map<string, SessionState>();
  /** Live hook signals by sessionId (F5). Fed by the extension's signal watcher. */
  private signals = new Map<string, HookSignal>();
  /** Materialized session nodes (those VS Code has requested), for targeted refreshes. */
  private nodeIndex = new Map<string, TreeNode>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: MetaStore,
    private root: string = defaultProjectsRoot(),
    private includeTemp = false,
    private thresholds: StateThresholds = {},
    /** Invoked when the number of topics that need you changes (for badge + status bar). */
    private readonly onAttentionChange?: (count: AttentionCount) => void,
  ) {
    this.reload();
    this.startTimer();
  }

  configure(root: string, includeTemp: boolean, thresholds?: StateThresholds): void {
    this.root = root;
    this.includeTemp = includeTemp;
    if (thresholds) this.thresholds = thresholds;
    this.reload();
  }

  /** The session open in the viewer: does not animate (focus rule) nor count in the badge. */
  setOpenSession(id: string | null): void {
    if (this.openSessionId === id) return;
    this.openSessionId = id;
    this.refreshStates(true);
  }

  /** Reapplies the current count to the badge/status bar (e.g. after creating the TreeView). */
  reemitAttention(): void {
    this.onAttentionChange?.(this.lastAttention);
  }

  /** F5: replace the live hook-signal map (from the signal watcher) and refresh states. */
  updateSignals(signals: Map<string, HookSignal>): void {
    this.signals = signals;
    this.refreshStates(false);
  }

  private startTimer(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * A single pass over all sessions: computes their state (prefiltering by mtime, without parsing
   * the dormant ones), fills the cache and counts those that need you (excluding the open one and the
   * archived/hidden ones). Returns whether any state changed with respect to the previous pass.
   */
  private recomputeStates(): { count: AttentionCount; statesChanged: boolean } {
    const { states, count } = liveScan(this.projects, this.store, Date.now(), {
      excludeId: this.openSessionId,
      thresholds: this.thresholds,
      signals: this.signals,
    });
    let statesChanged = states.size !== this.stateCache.size;
    if (!statesChanged) {
      for (const [id, state] of states) {
        if (this.stateCache.get(id) !== state) {
          statesChanged = true;
          break;
        }
      }
    }
    this.stateCache = states;
    return { count, statesChanged };
  }

  /** Recomputes states and propagates: badge if the count changed, re-render if the structure changed. */
  private refreshStates(forceRender: boolean): void {
    const { count, statesChanged } = this.recomputeStates();
    if (!sameCount(count, this.lastAttention)) {
      this.lastAttention = count;
      this.onAttentionChange?.(count);
    }
    if (forceRender || statesChanged) this.emitter.fire(undefined);
  }

  /**
   * Each tick: recomputes. If any state changed, full re-render (re-sorts the tree). If not,
   * only blinks: toggles the frame and refreshes ONLY the nodes that blink (not the whole tree).
   */
  private tick(): void {
    const { count, statesChanged } = this.recomputeStates();
    if (!sameCount(count, this.lastAttention)) {
      this.lastAttention = count;
      this.onAttentionChange?.(count);
    }
    if (statesChanged) {
      this.emitter.fire(undefined);
      return;
    }
    if (count.total === 0) return; // nothing to blink → static tree (the 🟢 spin on their own)
    this.blinkOn = !this.blinkOn;
    for (const [id, state] of this.stateCache) {
      if (id === this.openSessionId || !needsAttention(state)) continue;
      const node = this.nodeIndex.get(id);
      if (node) this.emitter.fire(node); // targeted refresh of the node that blinks
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  reload(): void {
    this.projects = listProjects(this.root, { includeTemp: this.includeTemp });
    this.nodeIndex.clear();
    this.refreshStates(true);
  }

  getProjects(): ProjectEntry[] {
    return this.projects;
  }

  /** State of a session: from the cached pass if present; otherwise, direct computation (fallback). */
  private stateOf(session: SessionEntry): SessionState {
    return this.stateCache.get(session.id) ?? liveStateOf(session.path, session.mtimeMs, Date.now(), this.thresholds);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.projects.map((project) => ({ kind: 'project', project }));
    if (node.kind === 'project') {
      const showArchived = this.store.showArchived;
      const visible = node.project.sessions.filter((s) => {
        const meta = this.store.get(s.id);
        if (meta.hidden) return false;
        if (meta.archived && !showArchived) return false;
        return true;
      });
      // Order by urgency: actionable items on top (blocked → awaiting → working → idle), then recency.
      return visible
        .map((session) => ({ session, prio: statePriority(this.stateOf(session)) }))
        .sort((a, b) => a.prio - b.prio || b.session.mtimeMs - a.session.mtimeMs)
        .map(({ session }) => {
          const child: TreeNode = { kind: 'session', session, project: node.project };
          this.nodeIndex.set(session.id, child); // we remember the instance for targeted refreshes
          return child;
        });
    }
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(projectShortName(node.project), vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(node.project.sessions.length);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'project';
      item.tooltip = node.project.dir;
      return item;
    }

    const s = node.session;
    const meta = this.store.get(s.id);
    let label = meta.label;
    let recaps = 0;
    let messages = 0;
    let lastTs: string | null = null;
    try {
      const detail = getDetail(s.path);
      label = label ?? sessionLabel(detail, s.id);
      recaps = detail.recaps.length;
      messages = detail.messages.length;
      lastTs = detail.lastTs;
    } catch {
      label = label ?? s.id.slice(0, 8);
    }

    // Last interaction: we prefer the timestamp of the last transcript event;
    // otherwise, the file's mtime (which also reflects the last write).
    const parsed = lastTs ? Date.parse(lastTs) : NaN;
    const lastMs = Number.isNaN(parsed) ? s.mtimeMs : parsed;

    const state = meta.archived ? 'idle' : this.stateOf(s);
    const snoozed = !meta.archived && !!meta.snoozedUntil && Date.now() < meta.snoozedUntil;
    const frozen = s.id === this.openSessionId || snoozed; // focus rule + snoozed: do not animate
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = s.id; // stable id: lets VS Code refresh this node in a targeted way
    item.description = `${snoozed ? '💤 ' : ''}${recaps ? `★${recaps} ` : ''}${relTime(lastMs)}`;
    item.iconPath = iconFor(state, this.blinkOn, frozen, !!meta.archived);
    item.contextValue = meta.archived ? 'session-archived' : snoozed ? 'session-snoozed' : 'session';

    const tip = new vscode.MarkdownString();
    tip.supportThemeIcons = true;
    if (!meta.archived) tip.appendMarkdown(`**${vscode.l10n.t('Status:')}** ${stateLabel(state)}\n\n`);
    if (snoozed) tip.appendMarkdown(`$(bell-slash) ${vscode.l10n.t('Snoozed until {0}', fmtDateTime(meta.snoozedUntil!))}\n\n`);
    tip.appendMarkdown(`**${vscode.l10n.t('Last interaction:')}** ${fmtDateTime(lastMs)}\n\n`);
    tip.appendMarkdown(`${vscode.l10n.t('{0} messages · {1} recaps', messages || '?', recaps)}\n\n`);
    tip.appendMarkdown(`\`${s.path}\``);
    item.tooltip = tip;

    item.command = { command: 'laiaChats.open', title: 'Open', arguments: [node] };
    return item;
  }
}
