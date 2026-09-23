# Contributing

Thanks for helping improve `@codecapitano/pi-worktree`.

By contributing, you agree to license your contribution under the repository's [MIT License](LICENSE). You retain the copyright to your contribution unless you make a separate written agreement.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Project structure

The Pi extension lives in `extensions/git-worktree.ts`. Pi loads the TypeScript source directly, so the package has no build step.

## Prerequisites

- [Bun](https://bun.sh/)
- [Pi](https://pi.dev) CLI
- Git 2.20 or later
- Optional: [GitHub CLI](https://cli.github.com/) for `/worktree pr`

## Local setup

```bash
git clone https://github.com/codecapitano/pi-worktree.git
cd pi-worktree
bun install
pi -e ./extensions/git-worktree.ts
```

If Pi already loads a copied `~/.pi/agent/extensions/git-worktree.ts`, remove that copy to avoid loading the extension twice.

## Making changes

1. Keep changes focused.
2. Preserve the original MIT license and the provenance in `NOTICE.md`.
3. Preserve the safety guarantees documented in the README.
4. Test destructive paths in a disposable repository.
5. Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.

## Pull requests

Describe the behavior you changed and the commands you tested. Do not add package publication credentials or enable automated publication as part of an unrelated change.

## Security

Report vulnerabilities through the repository's private vulnerability reporting form. See [SECURITY.md](SECURITY.md).
