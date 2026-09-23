# @codecapitano/pi-worktree

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Git worktree slash commands for [Pi](https://pi.dev).

Create, list, open, remove, and check out pull request worktrees without leaving the session.

This repository is a maintained fork of [`thisuxhq/pi-worktree`](https://github.com/thisuxhq/pi-worktree). See [NOTICE.md](NOTICE.md) for its provenance.

## Layout

```text
~/AGI/mobile/               ← main checkout
~/AGI/mobile-fix-login/     ← worktree for fix/login
```

Sibling folders next to the main repository use the form `<repo>-<branch-slug>`.

## Install

The fork is not published to npm. Install it from GitHub:

```bash
pi install git:github.com/codecapitano/pi-worktree
```

Already in a session?

```text
/reload
```

Try the local extension during development:

```bash
pi -e ./extensions/git-worktree.ts
```

## Usage

| Command | What it does |
|---|---|
| `/worktree` | List worktrees; pick one to copy its path |
| `/worktree ls` | List worktrees |
| `/worktree <branch>` | Create a worktree for a branch |
| `/worktree add <branch>` | Create a worktree for a branch |
| `/worktree open <branch>` | Show the path and copy it on macOS |
| `/worktree rm <branch>` | Remove a worktree after confirmation; keep the branch |
| `/worktree pr <number>` | Fetch a pull request with `gh` and create a worktree |
| `/worktree help` | Show command help |

### Create behavior

1. If the local branch exists, attach a worktree to it.
2. Otherwise, if `origin/<branch>` exists, track it.
3. Otherwise, create the branch from the default branch, such as `origin/main`, `main`, or `master`.

If the branch already has a worktree, the command shows its existing path.

### Removal safety

- Refuses to remove the main worktree.
- Refuses to remove locked worktrees.
- Confirms before removal.
- Offers force removal after a second confirmation when a worktree is dirty.
- Keeps the branch.

The dirty-worktree behavior and the rest of the extension will undergo a safety review before this fork is recommended for regular use. Until that review is complete, use it only with disposable repositories.

### Pull request checkout

This command requires an authenticated [GitHub CLI](https://cli.github.com/):

```text
/worktree pr 42
```

## Development

```bash
git clone https://github.com/codecapitano/pi-worktree.git
cd pi-worktree
bun install
pi -e ./extensions/git-worktree.ts
```

The repository is intentionally private to package registries for now. Automated publication is disabled until the fork has been reviewed and tested.

## Links

- [Upstream](https://github.com/thisuxhq/pi-worktree)
- [Fork provenance](NOTICE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Repository](https://github.com/codecapitano/pi-worktree)

## License

The original work is copyright © 2026 [THISUX Private Limited](https://github.com/thisuxhq).

The original work and modifications are available under the [MIT License](LICENSE). Retain the copyright and permission notice when copying or distributing substantial portions of the software.
