# Laia Agent Router

**A live attention router for developers who run many Claude Code sessions at once.**

When you drive several [Claude Code](https://claude.com/claude-code) agents across multiple
projects and windows, the hard part isn't the work — it's knowing **which session needs you right
now**. Laia Agent Router turns your Claude Code history from a static archive into a live control
panel: at a glance you see who is working, who is waiting on you, and who is stuck.

> Built and open-sourced by [LaiaDesk](https://laiadesk.com) as a contribution to the Claude Code
> community. Free and MIT-licensed.

## Why

Modern AI-assisted development is increasingly **multi-agent and multi-project**: you kick off a
task in one repo, switch to another while it runs, review a third. Context gets lost. Laia Agent
Router is for that workflow — the "router of attention" for people juggling many concurrent agents.

## What it does

- **Live status per session** — derived read-only from each session's transcript:
  - 🟢 **working** — the agent is doing something (called a tool, about to respond).
  - 🟡 **your turn** — the agent finished its turn and is waiting on you.
  - 🔴 **blocked** — a tool call has been pending too long (likely a permission prompt or hang).
  - ⚪ **idle** — no recent activity; off the radar.
- **Attention badge & ordering** — the Activity Bar and status bar show how many sessions need you;
  the tree is sorted by urgency (blocked → your turn → working → idle).
- **Chat-style viewer** — read any past session like a conversation, with recaps highlighted.
- **Resume** — relaunch a session in a terminal (`claude --resume`), optionally with full
  permissions. Clicking a session focuses its existing terminal if one is open.
- **Recap timeline & global search** — jump across checkpoints and search every chat.
- **Add project** — scaffold a new project folder, optionally `git init`, a structured `PROJECT.md`,
  and launch an agent — without leaving the editor.
- **Bilingual** — English by default, Spanish when VS Code's display language is Spanish (native
  `vscode.l10n`). Contributions for more languages are welcome.

## Principles

- **Your transcripts are the single source of truth, and they are read-only.** The extension never
  modifies Claude Code's `.jsonl` files. Everything derived (status, labels, archiving) lives in a
  disposable store that can be rebuilt at any time. The only destructive action is an explicit,
  double-confirmed "delete permanently".

## Requirements

- VS Code `^1.85.0`
- [Claude Code](https://claude.com/claude-code) installed, with sessions under `~/.claude/projects/`.

## Install (from source)

```bash
npm install
npm run build           # bundle to dist/extension.cjs
npx @vscode/vsce package --allow-missing-repository   # produces a .vsix
code --install-extension laia-agent-router-*.vsix
```

Then reload VS Code. The **Laia Agent Router** view appears in the Activity Bar.

## Development

```bash
npm test         # vitest (pure core logic is fully tested)
npm run typecheck
npm run build
```

The codebase separates **pure, testable core** (`src/core/*`: catalog, parser, live-state engine,
project scaffolding) from a **thin VS Code layer** (`src/extension.ts`, `src/ui/*`). New behavior
is developed test-first.

## Contributing

Contributions are very welcome — this is meant to grow with the community. See
[CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Open an issue to
discuss an idea, or send a pull request from a fork.

## License

[MIT](LICENSE) © LaiaDesk
