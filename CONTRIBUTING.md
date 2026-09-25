# Contributing

Thanks for helping improve `@codecapitano/pi-worktree`.

By contributing, you agree to license your contribution under the repository's [MIT License](LICENSE). Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Project structure

- `extensions/git-worktree.ts`: Pi entry point, command registration, Git operations, and shortcut registration.
- `lib/worktree-picker.ts`: filterable TUI picker and picker labels.
- `lib/session-switch.ts`: persisted-session checks, latest-leaf checks, conversation forking, and session switching.
- `lib/finish-worktree.ts`: `/wt done` safety checks and cleanup after session replacement.
- `lib/config.ts`: shortcut validation and persistence.
- `test/`: Node test files for configuration, Git behavior, session switching, and picker behavior.

Pi loads the TypeScript source directly. There is no build step.

## Prerequisites

- Node.js 24 or later
- Pi `>=0.84.2`, installed personally or globally
- Git `>=2.36`
- GitHub CLI for pull request checks

## Local setup

```bash
git clone https://github.com/codecapitano/pi-worktree.git
cd pi-worktree
npm test
pi -e ./extensions/git-worktree.ts
```

Run the extension in an ordinary TUI session when checking conversation switching. If Pi already loads a copied `~/.pi/agent/extensions/git-worktree.ts`, remove that copy to avoid loading the extension twice.

## Tests and manual checks

Run the automated suite with `npm test`. Manually verify:

1. `/wt` and `/worktree` open the picker, filter by branch, path, and commit, and switch only to available worktrees.
2. `/wt switch`, `/wt new`, `/wt add`, `/wt open`, `/wt path`, `/wt ls`, and `/wt rm` match the documented exact-match and confirmation behavior.
3. `/wt done` refuses the main checkout and secondary worktrees with uncommitted, untracked, or ignored files. From a clean secondary worktree, confirm that Pi switches to the main checkout before removing it, while keeping the branch and session files. Test a custom session directory inside the secondary worktree too; removal must be refused.
4. `/wt pr` fetches the PR, asks before switching, and retains the worktree when declined.
5. A switch requires TUI mode, an idle Pi with no queued messages, a persisted session, and the latest conversation leaf. Confirm that the new conversation is a fork and the original remains available.
6. Check the default `ctrl+alt+w` shortcut, `/wt config shortcut <key|off>`, `/reload`, and `/hotkeys`.
7. Review PR trust prompts and confirm that worktrees are not sandboxes.

Use a disposable repository for removal, dirty-worktree, PR, and trust checks.

## Making changes

1. Keep changes focused.
2. Preserve the original MIT license and fork provenance in `NOTICE.md`.
3. Preserve the safety guarantees documented in the README.
4. Do not add package publication credentials or enable automated publication as part of an unrelated change.
5. Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.

## Pull requests

Describe the behavior changed and the commands you tested. Include any mismatch between the implementation and the documentation.

## Security

Report vulnerabilities through the repository's private vulnerability reporting form. See [SECURITY.md](SECURITY.md).
