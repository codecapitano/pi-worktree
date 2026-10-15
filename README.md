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
pi install git:github.com/codecapitano/pi-worktree@pi-worktree-v2.1.0
```

This installs the latest tagged release. For unreleased features documented on `main`, including the terminal-pane preference, install the development version instead:

```bash
pi install git:github.com/codecapitano/pi-worktree
```

Either command replaces an existing Git installation of this package. Reload an existing Pi session after installation:

```text
/reload
```

Use `pi -e ./extensions/git-worktree.ts` for a one-off local session. To load a local clone in every Pi session, run `pi install /absolute/path/to/pi-worktree`. Local installs read the source directly, so pull changes and run `/reload` to use an update. Use only one installation source to avoid duplicate commands.

The package is private, so install releases from GitHub rather than npm.

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
| `/wt done` | Leave the current worktree for the main checkout, then remove it if it is still clean. Keep the branch and session history. |
| `/wt config` | Show the shortcut, terminal-pane preference, and config path. |
| `/wt config shortcut` | Show the current shortcut. |
| `/wt config shortcut <key>` | Save a shortcut. |
| `/wt config shortcut off` | Disable the shortcut. |
| `/wt config terminal-cwd` | Show the terminal-pane preference. |
| `/wt config terminal-cwd <on\|off>` | Choose whether new iTerm2 panes follow Pi's directory. |
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

A switch is available only in interactive TUI mode when Pi is idle and has no queued messages. You can switch immediately after starting Pi, before sending your first message. A fresh session keeps its setup entries in the target worktree. Existing conversations require their session file to be available. The active conversation must be the latest leaf. If you have branched the conversation, run `/fork` first.

Every switch, including picker and shortcut selections, asks you to confirm the target before loading it. Switching forks the current conversation into the target worktree and opens the fork. The original conversation remains retained in its original worktree.

Switching refuses an incomplete checkout when its index is empty but `HEAD` contains files, including unpopulated worktrees and checkouts with all files staged for deletion. It reports the target path without changing files or repairing the checkout. Inspection failures also block switching. The check runs before confirmation and again before forking and switching. Truly empty commits, populated dirty worktrees, and sparse checkouts remain allowed.

Run `/wt done` from a secondary worktree to return to the main checkout and remove the secondary checkout. Pi forks the conversation into the main checkout first. If the worktree has uncommitted, untracked, or ignored files, Pi stays put. If Git refuses removal after the switch, the worktree remains and Pi reports its path. `/wt done` refuses to remove a worktree that contains its session files. It never deletes the branch or session files.

## New terminal panes

Each switch confirmation, including `/wt done`, shows **New terminal panes**. Select that row to toggle between:

- **Keep original directory**, the default. Switching changes Pi only.
- **Follow Pi's worktree**. Report Pi's active directory to iTerm2 so new panes can start there.

The choice is saved globally as soon as you toggle it, even if you cancel the switch. You can also use `/wt config terminal-cwd on` or `/wt config terminal-cwd off`. Run `/wt config` to inspect the saved choice and its config path. The file is `~/.pi/agent/pi-worktree/config.json`, or under `PI_CODING_AGENT_DIR` if configured.

In iTerm2, open **Settings → Profiles → General** and set **Working Directory** to **Reuse previous session's directory**. Depending on your iTerm2 version, this section may be called **Initial Directory**. If you use **Advanced Configuration**, enable directory reuse for split panes. See [iTerm2's profile settings](https://iterm2.com/documentation-preferences-profiles-general.html).

Following Pi applies when a session starts, including after a worktree switch or reload. It does not move existing panes or change the shell directory you return to after exiting Pi. Disabling it or quitting Pi restores the reported launch directory. Other terminals, tmux, screen, and non-interactive output are unchanged.

## Pull request trust

`/wt pr <number>` fetches the PR head and refreshes its target branch at `origin/<target-branch>` for remote-base reviews, including when reusing an existing PR worktree. The target comes from GitHub and can be a branch other than `main`. Local target branches and the original checkout are unchanged. If the target cannot be refreshed, the command reports the error without creating or switching into the PR worktree.

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
