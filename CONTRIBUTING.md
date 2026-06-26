# Contributing to Laia Agent Router

Thanks for your interest in contributing! This project is open and community-driven — issues,
ideas, and pull requests are all welcome.

## Ways to contribute

- **Report bugs** — open an issue with steps to reproduce, expected vs actual behavior, and your
  VS Code / OS / Claude Code versions.
- **Propose features** — open an issue describing the workflow problem first. For anything
  non-trivial, let's align on the approach before code.
- **Send pull requests** — fix bugs, add languages, improve docs.

## Workflow

We use a fork + pull request model (no direct push to `main`).

1. Fork the repo and create a branch: `git checkout -b feat/short-description`.
2. Make your change, keeping the existing style and structure.
3. Add or update tests (see below) and make sure everything is green.
4. Open a PR against `main`. Fill in the PR template. PRs require review before merge.

## Branching

- **External contributors work from a fork.** You don't need (and won't get) write access to
  this repository. Fork it, push to a branch **on your fork**, and open a PR here. You can't
  push to this repo's branches — that's expected and keeps everyone safe.
- **One short-lived branch per change.** Name it for the work: `feat/...`, `fix/...`, `docs/...`.
  It gets deleted when the PR merges. Don't reuse a branch across unrelated changes.
- **Never commit to `main` directly, and don't share a long-lived branch** that several people
  push to at once — that's where conflicts happen. Branch → PR → merge → delete.
- `main` is protected: every change lands through a reviewed PR with green CI. This applies to
  maintainers too.

## Quality bar

Run these locally before opening a PR — CI runs the same:

```bash
npm install
npm run typecheck   # no type errors
npm test            # all tests green
npm run build       # bundles cleanly
```

- **Tests first.** Pure logic lives in `src/core/*` and is covered by `vitest`. New behavior should
  come with a test that fails before your change and passes after.
- **Keep the core pure.** `src/core/*` must not import `vscode`, so it stays unit-testable. The
  VS Code-specific glue belongs in `src/extension.ts` / `src/ui/*`.
- **Respect the read-only principle.** Never write to or mutate Claude Code's `.jsonl` transcripts.
- **English in code and docs.** User-facing strings go through `vscode.l10n.t()` (runtime) or the
  `package.nls.*` files (manifest), with English as the base language.

## Adding a translation

1. Add a `package.nls.<locale>.json` mirroring `package.nls.json`.
2. Add an `l10n/bundle.l10n.<locale>.json` mapping the English runtime strings to your language.
3. Test by switching VS Code's display language ("Configure Display Language").

## Reporting security issues

Please do not open public issues for security problems. Email **security@laiadesk.com** instead.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
