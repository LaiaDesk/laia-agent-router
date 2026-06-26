/**
 * Entry point of the "Laia Agent Router" extension.
 *
 * Thin layer over the core (core/*) and the rendering (ui/*). Registers the tree view,
 * a chat viewer (reusable webview), and the commands: open, resume, archive,
 * hide, delete (2 levels), rename, recaps timeline and global search.
 */

import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { defaultProjectsRoot } from './core/catalog';
import { getDetail, sessionLabel } from './core/details';
import { collectRecaps, search } from './core/insights';
import { resolveProjectPath, projectTemplate } from './core/newProject';
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

  const view = vscode.window.createTreeView('laiaChats.sessions', { treeDataProvider: tree });
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

  cmd('laiaChats.archive', (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    store.setArchived(node.session.id, true);
    tree.reload();
  });
  cmd('laiaChats.unarchive', (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    store.setArchived(node.session.id, false);
    tree.reload();
  });

  cmd('laiaChats.hide', (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    store.setHidden(node.session.id, true);
    tree.reload();
  });

  cmd('laiaChats.deleteForever', async (node: TreeNode) => {
    if (node?.kind !== 'session') return;
    const del = vscode.l10n.t('Delete permanently');
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Deleting this topic PERMANENTLY will erase its .jsonl transcript from disk. The history will be lost and it cannot be resumed. Continue?',
      ),
      { modal: true },
      del,
    );
    if (ok !== del) return;
    try {
      unlinkSync(node.session.path);
      store.setHidden(node.session.id, false); // clears metadata
      tree.reload();
      void vscode.window.showInformationMessage(vscode.l10n.t('Transcript deleted.'));
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not delete: {0}', (err as Error).message));
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
