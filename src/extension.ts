/**
 * Entry point of the "Laia Agent Router" extension.
 *
 * Thin layer over the core (core/*) and the rendering (ui/*). Registers the tree view,
 * a chat viewer (reusable webview), and the commands: open, resume, archive,
 * hide, delete (2 levels), rename, recaps timeline and global search.
 */

import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { unlinkSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { defaultProjectsRoot } from './core/catalog';
import { getDetail, sessionLabel } from './core/details';
import { collectRecaps, search } from './core/insights';
import { resolveProjectPath, projectTemplate } from './core/newProject';
import { buildThreadSummary, type ThreadDigest } from './core/summary';
import { parseSignal, type HookSignal } from './core/liveSignal';
import { mergeHookConfig } from './core/hookInstall';
import { MetaStore } from './core/store';
import type { AttentionCount, StateThresholds } from './core/state';
import { renderChatDocument, CHAT_STRINGS_EN, type ChatStrings } from './ui/html';
import { SessionsTree, type TreeNode } from './ui/tree';

function nonce(): string {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

/** Translates the chat viewer labels with vscode.l10n (English base in CHAT_STRINGS_EN). */
function chatStrings(): ChatStrings {
  const out = {} as ChatStrings;
  for (const [k, v] of Object.entries(CHAT_STRINGS_EN) as [keyof ChatStrings, string][]) {
    out[k] = vscode.l10n.t(v);
  }
  return out;
}

function config() {
  const cfg = vscode.workspace.getConfiguration('laiaChats');
  const root = cfg.get<string>('projectsRoot')?.trim() || defaultProjectsRoot();
  const includeTemp = cfg.get<boolean>('includeTempProjects') ?? false;
  const thresholds: StateThresholds = {
    blockedAfterMs: (cfg.get<number>('blockedAfterSeconds') ?? 60) * 1000,
    idleAfterMs: (cfg.get<number>('idleAfterMinutes') ?? 15) * 60_000,
  };
  return { root, includeTemp, thresholds };
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new MetaStore(join(homedir(), '.laia-chats', 'store.json'));
  const { root, includeTemp, thresholds } = config();

  // Status bar: textual summary of the topics that need you. Click → focuses the panel.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'workbench.view.extension.laiaChats';
  context.subscriptions.push(statusItem);

  // Badge on the Activity Bar icon + status bar, based on the number of topics that need you.
  let viewRef: vscode.TreeView<TreeNode> | undefined;
  function applyAttention(count: AttentionCount): void {
    if (viewRef) {
      viewRef.badge = count.total
        ? { value: count.total, tooltip: vscode.l10n.t('{0} topic(s) need you', count.total) }
        : undefined;
    }
    if (count.total === 0) {
      statusItem.hide();
      return;
    }
    const parts: string[] = [];
    if (count.awaiting) parts.push(vscode.l10n.t('$(circle-filled) {0} your turn', count.awaiting));
    if (count.blocked) parts.push(vscode.l10n.t('$(error) {0} blocked', count.blocked));
    statusItem.text = parts.join('  ·  ');
    statusItem.tooltip = vscode.l10n.t('Laia Agent Router — topics waiting for your turn');
    statusItem.backgroundColor = count.blocked
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.show();
  }

  const tree = new SessionsTree(store, root, includeTemp, thresholds, applyAttention);
  context.subscriptions.push({ dispose: () => tree.dispose() });

  const view = vscode.window.createTreeView('laiaChats.sessions', {
    treeDataProvider: tree,
    canSelectMany: true, // Shift/Cmd-click to act on several sessions at once
  });
  viewRef = view;
  context.subscriptions.push(view);
  // The initial count was computed in the tree constructor, when `viewRef` did not exist yet:
  // reapply it now so the Activity Bar badge already appears at startup.
  tree.reemitAttention();

  // Automatic refresh when the transcripts change.
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.jsonl'));
  const refresh = () => tree.reload();
  watcher.onDidCreate(refresh);
  watcher.onDidChange(refresh);
  watcher.onDidDelete(refresh);
  context.subscriptions.push(watcher);

  // ---- F5: live signal from Claude Code hooks ----
  // The hook helper writes ~/.laia-chats/signals/<sessionId>.json on each event; we watch that
  // folder and feed the parsed signals to the tree, where they override transcript inference.
  const signalsDir = join(homedir(), '.laia-chats', 'signals');
  const signals = new Map<string, HookSignal>();
  const sessionIdOf = (p: string) => basename(p, '.json');
  const loadSignal = (p: string) => {
    try {
      const sig = parseSignal(readFileSync(p, 'utf8'));
      if (sig) signals.set(sessionIdOf(p), sig);
    } catch {
      /* file vanished or unreadable: ignore */
    }
  };
  try {
    mkdirSync(signalsDir, { recursive: true });
    for (const f of readdirSync(signalsDir)) {
      if (f.endsWith('.json')) loadSignal(join(signalsDir, f));
    }
  } catch {
    /* no signals yet */
  }
  tree.updateSignals(signals);
  const sigWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(signalsDir, '*.json'));
  const onSig = (uri: vscode.Uri) => {
    loadSignal(uri.fsPath);
    tree.updateSignals(signals);
  };
  sigWatcher.onDidCreate(onSig);
  sigWatcher.onDidChange(onSig);
  sigWatcher.onDidDelete((uri) => {
    signals.delete(sessionIdOf(uri.fsPath));
    tree.updateSignals(signals);
  });
  context.subscriptions.push(sigWatcher);

  // ---- Chat viewer (a single reusable panel) ----
  let panel: vscode.WebviewPanel | undefined;
  // We keep the CURRENT session of the panel (we don't capture it in the handler's closure,
  // which is registered only once): this way Resume always uses the cwd of the visible session.
  let panelSession: { id: string; path: string } | null = null;

  // Terminals open per session (those created by "Resume"/full permissions/play).
  // Used so that, when clicking a session, its terminal is focused if it is still alive.
  const terminalsBySession = new Map<string, vscode.Terminal>();
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of terminalsBySession) {
        if (term === t) terminalsBySession.delete(id);
      }
    }),
  );

  const safeCwd = (path: string): string | null => {
    try {
      return getDetail(path).cwd;
    } catch {
      return null;
    }
  };

  function openSession(node: TreeNode | undefined): void {
    if (!node || node.kind !== 'session') return;
    const { session } = node;
    let detail;
    try {
      detail = getDetail(session.path);
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not read the session: {0}', (err as Error).message));
      return;
    }
    const meta = store.get(session.id);
    const title = meta.label ?? sessionLabel(detail, session.id);

    if (!panel) {
      panel = vscode.window.createWebviewPanel('laiaChat', 'Laia Chat', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.onDidDispose(() => {
        panel = undefined;
        panelSession = null;
        tree.setOpenSession(null); // no session is focused anymore
      });
      panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
        // Resolves the cwd of the CURRENT session at click time (not from the closure).
        if (msg?.type === 'resume' && panelSession) {
          resumeById(panelSession.id, panelSession.path, safeCwd(panelSession.path), skipPermissionsByDefault());
        }
        if (msg?.type === 'resumeFull' && panelSession) {
          resumeById(panelSession.id, panelSession.path, safeCwd(panelSession.path), true);
        }
      });
    }
    panelSession = { id: session.id, path: session.path };
    tree.setOpenSession(session.id); // focus rule: this topic stops animating/counting
    panel.title = title.length > 40 ? title.slice(0, 40) + '…' : title;
    panel.webview.html = renderChatDocument(detail, {
      nonce: nonce(),
      cspSource: panel.webview.cspSource,
      title,
      projectName: detail.cwd ?? node.project.displayName,
      resumeId: session.id,
      cwd: detail.cwd,
      i18n: chatStrings(),
      lang: vscode.env.language,
    });
    panel.reveal();

    // Attachment: if this session already has an open terminal, position yourself on it.
    // If it doesn't exist, nothing happens (the user launches it with Resume/permissions/play).
    const openTerminal = findTerminal(session.id, session.path);
    if (openTerminal) openTerminal.show();
  }

  /** Resume with full permissions by default? (read at click time). */
  function skipPermissionsByDefault(): boolean {
    return vscode.workspace.getConfiguration('laiaChats').get<boolean>('resumeSkipPermissions') ?? false;
  }

  /** Readable label of the session, same as in the tree (editable label → ai-title → short id). */
  function sessionDisplayName(sessionId: string, path: string): string {
    const meta = store.get(sessionId);
    if (meta.label) return meta.label;
    try {
      return sessionLabel(getDetail(path), sessionId);
    } catch {
      return sessionId.slice(0, 8);
    }
  }

  /** Terminal name of a session. Single source for creating and for finding it again. */
  function terminalLabel(sessionId: string, path: string): string {
    return `Laia · ${sessionDisplayName(sessionId, path)}`;
  }

  /**
   * Returns the live terminal of the session, if it exists. First the map (those created
   * by this startup); if not, adopts by name one that survived a window reload
   * (VS Code keeps terminals but the extension loses its reference).
   */
  function findTerminal(sessionId: string, path: string): vscode.Terminal | undefined {
    const tracked = terminalsBySession.get(sessionId);
    if (tracked) return tracked;
    const label = terminalLabel(sessionId, path);
    const adopted = vscode.window.terminals.find((t) => t.name === label);
    if (adopted) terminalsBySession.set(sessionId, adopted);
    return adopted;
  }

  /**
   * "Add project": asks for a path (the only required field) and, optionally, runs `git init`,
   * creates a `PROJECT.md` from a template and launches `claude` in the folder. Non-destructive: warns if
   * the folder or the PROJECT.md already exist, but allows continuing.
   */
  async function addProject(): Promise<void> {
    const base = vscode.workspace.getConfiguration('laiaChats').get<string>('newProjectRoot')?.trim() || homedir();

    const cleanBase = base.replace(/\/+$/, '');
    const input = await vscode.window.showInputBox({
      title: vscode.l10n.t('Add project'),
      prompt: vscode.l10n.t('Project folder path (the only required field).'),
      value: cleanBase + '/',
      valueSelection: [cleanBase.length + 1, cleanBase.length + 1],
      validateInput: (v) =>
        v.trim() && v.trim() !== '~' ? null : vscode.l10n.t('Type a name or path for the project.'),
    });
    if (!input) return; // cancelled

    const path = resolveProjectPath(input, homedir());
    const name = basename(path);

    if (existsSync(path)) {
      const cont = vscode.l10n.t('Continue');
      const go = await vscode.window.showWarningMessage(
        vscode.l10n.t('The folder already exists:\n{0}\nContinue anyway?', path),
        { modal: true },
        cont,
      );
      if (go !== cont) return;
    }

    type Step = { label: string; key: 'git' | 'project' | 'claude' };
    const picks = await vscode.window.showQuickPick<vscode.QuickPickItem & Step>(
      [
        { label: 'git init', key: 'git', picked: true },
        { label: vscode.l10n.t('Create PROJECT.md (template)'), key: 'project', picked: true },
        { label: vscode.l10n.t('Open terminal and launch claude'), key: 'claude', picked: true },
      ],
      {
        title: vscode.l10n.t('Add project · {0}', name),
        placeHolder: vscode.l10n.t('What to include (all optional)'),
        canPickMany: true,
      },
    );
    if (picks === undefined) return; // cancelled: nothing is created

    const want = new Set(picks.map((p) => p.key));

    try {
      mkdirSync(path, { recursive: true });

      if (want.has('project')) {
        const file = join(path, 'PROJECT.md');
        let write = true;
        if (existsSync(file)) {
          const overwrite = vscode.l10n.t('Overwrite');
          const ow = await vscode.window.showWarningMessage(
            vscode.l10n.t('A PROJECT.md already exists in:\n{0}\nOverwrite it?', path),
            { modal: true },
            overwrite,
          );
          write = ow === overwrite;
        }
        if (write) writeFileSync(file, projectTemplate(name, (s) => vscode.l10n.t(s)), 'utf8');
      }

      if (want.has('git')) execFileSync('git', ['init'], { cwd: path });

      if (want.has('claude')) {
        const terminal = vscode.window.createTerminal({ name: `Laia · ${name}`, cwd: path });
        terminal.show();
        terminal.sendText('claude');
      }
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not create the project: {0}', (err as Error).message));
      return;
    }

    tree.reload();
    const projectFile = join(path, 'PROJECT.md');
    if (existsSync(projectFile)) {
      void vscode.window.showTextDocument(vscode.Uri.file(projectFile));
    }
  }

  /**
   * F5: "Enable live status". Installs the hook helper and merges our hooks into the user's
   * Claude Code settings.json (non-destructive, idempotent), after explicit confirmation.
   */
  async function enableLiveSignal(): Promise<void> {
    const laiaDir = join(homedir(), '.laia-chats');
    const helperDest = join(laiaDir, 'hook-signal.mjs');
    const helperSrc = vscode.Uri.joinPath(context.extensionUri, 'assets', 'hook-signal.mjs').fsPath;
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const command = `node "${helperDest}"`;

    const enable = vscode.l10n.t('Enable');
    const ok = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Enable live status? This installs a small helper and adds Laia hooks to your Claude Code settings ({0}). Your existing settings are preserved.',
        settingsPath,
      ),
      { modal: true },
      enable,
    );
    if (ok !== enable) return;

    try {
      mkdirSync(laiaDir, { recursive: true });
      copyFileSync(helperSrc, helperDest);
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      else mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(mergeHookConfig(settings, command), null, 2) + '\n', 'utf8');
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Live status enabled. Claude Code applies the hooks automatically.'),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not enable live status: {0}', (err as Error).message));
    }
  }

  function resumeById(sessionId: string, path: string, cwd: string | null, skipPermissions: boolean): void {
    const flag = skipPermissions ? ' --dangerously-skip-permissions' : '';
    // The terminal name matches the topic name in the tree (full, untruncated).
    const terminal = vscode.window.createTerminal({ name: terminalLabel(sessionId, path), cwd: cwd ?? undefined });
    terminalsBySession.set(sessionId, terminal);
    terminal.show();
    terminal.sendText(`claude --resume ${sessionId}${flag}`);
  }

  // ---- Commands ----
  const cmd = (id: string, fn: (...a: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('laiaChats.addProject', () => void addProject());
  cmd('laiaChats.enableLiveSignal', () => void enableLiveSignal());

  // New chat session in an existing project: open a terminal in its cwd and launch `claude`.
  cmd('laiaChats.newSession', (node: TreeNode) => {
    if (node?.kind !== 'project') return;
    const newest = node.project.sessions[0];
    const cwd = newest ? safeCwd(newest.path) : null;
    const label = cwd ? basename(cwd) : node.project.displayName;
    const terminal = vscode.window.createTerminal({ name: `Laia · ${label} (new)`, cwd: cwd ?? undefined });
    terminal.show();
    terminal.sendText('claude');
  });

  cmd('laiaChats.open', openSession);
  cmd('laiaChats.refresh', () => tree.reload());

  cmd('laiaChats.resume', (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    resumeById(node.session.id, node.session.path, safeCwd(node.session.path), skipPermissionsByDefault());
  });

  cmd('laiaChats.resumeFull', (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    resumeById(node.session.id, node.session.path, safeCwd(node.session.path), true);
  });

  // With canSelectMany, context-menu commands receive (clickedNode, allSelectedNodes).
  // Fall back to the single clicked node; keep only session nodes.
  type SessionNode = Extract<TreeNode, { kind: 'session' }>;
  const selectedSessions = (node?: TreeNode, nodes?: TreeNode[]): SessionNode[] =>
    (nodes?.length ? nodes : node ? [node] : []).filter((n): n is SessionNode => !!n && n.kind === 'session');

  cmd('laiaChats.archive', (node: TreeNode, nodes?: TreeNode[]) => {
    const sel = selectedSessions(node, nodes);
    if (!sel.length) return;
    for (const n of sel) store.setArchived(n.session.id, true);
    tree.reload();
  });
  cmd('laiaChats.unarchive', (node: TreeNode, nodes?: TreeNode[]) => {
    const sel = selectedSessions(node, nodes);
    if (!sel.length) return;
    for (const n of sel) store.setArchived(n.session.id, false);
    tree.reload();
  });

  cmd('laiaChats.hide', (node: TreeNode, nodes?: TreeNode[]) => {
    const sel = selectedSessions(node, nodes);
    if (!sel.length) return;
    for (const n of sel) store.setHidden(n.session.id, true);
    tree.reload();
  });

  cmd('laiaChats.snooze', async (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    const options = [
      { label: vscode.l10n.t('30 minutes'), ms: 30 * 60_000 },
      { label: vscode.l10n.t('1 hour'), ms: 60 * 60_000 },
      { label: vscode.l10n.t('4 hours'), ms: 4 * 60 * 60_000 },
      { label: vscode.l10n.t('1 day'), ms: 24 * 60 * 60_000 },
    ];
    const pick = await vscode.window.showQuickPick(options, { title: vscode.l10n.t('Snooze this topic for…') });
    if (!pick) return;
    store.setSnoozedUntil(node.session.id, Date.now() + pick.ms);
    tree.reload();
  });
  cmd('laiaChats.unsnooze', (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    store.setSnoozedUntil(node.session.id, undefined);
    tree.reload();
  });

  // Consolidate the recaps of the selected sessions into a digest and seed a new session with it.
  cmd('laiaChats.summarizeSelection', async (node: TreeNode, nodes?: TreeNode[]) => {
    const sel = selectedSessions(node, nodes);
    if (!sel.length) return;
    const threads: ThreadDigest[] = sel.map((n) => {
      try {
        const detail = getDetail(n.session.path);
        return {
          label: sessionDisplayName(n.session.id, n.session.path),
          project: detail.cwd ?? undefined,
          ts: detail.lastTs,
          recaps: detail.recaps.map((r) => ({ text: r.text })),
        };
      } catch {
        return { label: sessionDisplayName(n.session.id, n.session.path), recaps: [] };
      }
    });
    const summary = buildThreadSummary(threads);
    const doc = await vscode.workspace.openTextDocument({ content: summary, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
    await vscode.env.clipboard.writeText(summary);
    const cwd = safeCwd(sel[0]!.session.path);
    const terminal = vscode.window.createTerminal({ name: 'Laia · new session', cwd: cwd ?? undefined });
    terminal.show();
    terminal.sendText('claude');
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Summary of {0} thread(s) copied to clipboard — paste it into the new session to seed it.', sel.length),
    );
  });

  cmd('laiaChats.deleteForever', async (node: TreeNode, nodes?: TreeNode[]) => {
    const sel = selectedSessions(node, nodes);
    if (!sel.length) return;
    const del = vscode.l10n.t('Delete permanently');
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Permanently delete {0} topic(s)? Their .jsonl transcripts will be erased from disk; the history is lost and cannot be resumed.',
        sel.length,
      ),
      { modal: true },
      del,
    );
    if (ok !== del) return;
    let deleted = 0;
    const errors: string[] = [];
    for (const n of sel) {
      try {
        unlinkSync(n.session.path);
        store.setHidden(n.session.id, false); // clears metadata
        deleted++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    tree.reload();
    if (errors.length) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not delete {0} of {1}: {2}', errors.length, sel.length, errors[0]!),
      );
    } else {
      void vscode.window.showInformationMessage(vscode.l10n.t('Deleted {0} transcript(s).', deleted));
    }
  });

  cmd('laiaChats.rename', async (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    const current = store.get(node.session.id).label ?? '';
    const value = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Topic label'), value: current });
    if (value === undefined) return;
    store.setLabel(node.session.id, value);
    tree.reload();
  });

  cmd('laiaChats.toggleArchived', () => {
    store.setShowArchived(!store.showArchived);
    void vscode.window.showInformationMessage(
      store.showArchived ? vscode.l10n.t('Archived: visible') : vscode.l10n.t('Archived: hidden'),
    );
    tree.reload();
  });

  // Recaps timeline as a QuickPick: "bring up the summary of the latest ones".
  cmd('laiaChats.recapTimeline', async () => {
    const recaps = collectRecaps(tree.getProjects());
    if (!recaps.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No recaps detected yet.'));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      recaps.map((r) => ({
        label: `★ ${r.text.slice(0, 80)}`,
        detail: `${r.sessionLabel} · ${r.projectName} · ${r.ts ?? ''}`,
        recap: r,
      })),
      { title: vscode.l10n.t('Recap summary (most recent first)'), matchOnDetail: true },
    );
    if (pick) openByPath(pick.recap.path, pick.recap.projectKey);
  });

  cmd('laiaChats.search', async () => {
    const query = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Search across all chats (you and Claude)') });
    if (!query) return;
    const hits = search(tree.getProjects(), query);
    if (!hits.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No results.'));
      return;
    }
    const you = vscode.l10n.t('You');
    const pick = await vscode.window.showQuickPick(
      hits.map((h) => ({
        label: `${h.role === 'assistant' ? 'Claude' : you}: ${h.snippet}`,
        detail: `${h.sessionLabel} · ${h.projectName}`,
        hit: h,
      })),
      { title: vscode.l10n.t('{0} results', hits.length), matchOnDetail: true },
    );
    if (pick) openByPath(pick.hit.path, pick.hit.projectKey);
  });

  function openByPath(path: string, projectKey: string): void {
    const project = tree.getProjects().find((p) => p.key === projectKey);
    const session = project?.sessions.find((s) => s.path === path);
    if (project && session) openSession({ kind: 'session', session, project });
  }

  // Reacts to configuration changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('laiaChats')) {
        const c = config();
        tree.configure(c.root, c.includeTemp, c.thresholds);
      }
    }),
  );
}

export function deactivate(): void {
  /* nothing to clean up: subscriptions are released on their own */
}
