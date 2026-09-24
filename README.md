# @codecapitano/pi-worktree

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Switch Pi conversations between Git worktrees. This maintained fork of [`thisuxhq/pi-worktree`](https://github.com/thisuxhq/pi-worktree) preserves its provenance. See [NOTICE.md](NOTICE.md).

## Requirements

- Pi `>=0.84.2`
- Git `>=2.36`
- A personal or global Pi installation. The extension must be installed for the Pi user, not only in a repository-local project.
- GitHub CLI (`gh`) for pull request worktrees

## Install

```bash
pi install git:github.com/codecapitano/pi-worktree@pi-worktree-v2.0.0
```

Run the same install command to replace an older pinned version. Reload an existing Pi session after installation:

```text
/reload
```

Use `pi -e ./extensions/git-worktree.ts` when developing locally. The package is private, so install from the GitHub release tag rather than npm.

## Commands

`/wt` is the canonical command. `/worktree` is an alias.

| Command | Behavior |
|---|---|
| `/wt` | Open a filterable picker and switch to the selected worktree. Filter by branch, path, or commit. |
| `/wt switch <branch-or-path>` | Switch using an exact branch or path. |
| `/wt <branch-or-path>` | Switch on an exact match, or confirm before creating and switching. |
| `/wt new <branch>` | Create a worktree, then switch to it. |
| `/wt add <branch>` | Alias for `/wt new <branch>`. |
| `/wt pr <number>` | Fetch a pull request, create its worktree, and ask before switching. The worktree is retained if you decline. |
| `/wt open <branch-or-path>` | Show the path and copy it on macOS. |
| `/wt path <branch-or-path>` | Show the path and copy it on macOS. |
| `/wt ls` | List worktrees. |
| `/wt rm <branch-or-path>` | Remove an exact, clean worktree after confirmation. The branch is kept. |
| `/wt config shortcut` | Show the current shortcut. |
| `/wt config shortcut <key>` | Save a shortcut. |
| `/wt config shortcut off` | Disable the shortcut. |
| `/wt help` | Show command help. |

The default picker shortcut is `ctrl+alt+w`. Configure it with `/wt config shortcut <key|off>`. The command reloads Pi resources after a change. Use `/hotkeys` to inspect the active shortcuts.

When the main checkout's parent has a `worktrees/` directory, worktrees are created at `worktrees/<repo>/<branch-slug>`:

```text
~/workspace/mobile/                         # main checkout
~/workspace/worktrees/mobile/fix-login/     # worktree for fix/login
```

Otherwise, worktrees are siblings of the main checkout, named `<repo>-<branch-slug>`:

```text
~/foo/mobile/            # main checkout
~/foo/mobile-fix-login/  # worktree for fix/login
```

## Switching conversations

A switch is available only in interactive TUI mode when Pi is idle, has no queued messages, and the session is persisted. The active conversation must be the latest leaf. If you have branched the conversation, run `/fork` first.

Every switch, including picker and shortcut selections, asks you to confirm the target before loading it. Switching forks the current conversation into the target worktree and opens the fork. The original conversation remains retained in its original worktree.

## Pull request trust

`/wt pr` and every other way of entering a worktree ask for confirmation before continuing. PR code, `AGENTS.md`, `CLAUDE.md`, and trusted `.pi` resources may load. Trust in the parent conversation or repository does not make PR content safe. Review the code and trust boundaries before confirming.

Worktrees are directory and Git separation only. They are not a sandbox and do not restrict Pi, Git, `gh`, hooks, scripts, or other processes from using the user's operating-system permissions.

## Development

```bash
git clone https://github.com/codecapitano/pi-worktree.git
cd pi-worktree
npm test
pi -e ./extensions/git-worktree.ts
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the module layout and manual checks. Preserve the original attribution and fork provenance in [NOTICE.md](NOTICE.md).

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
