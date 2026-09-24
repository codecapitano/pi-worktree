# Security policy

## Supported versions

Version 2.0.1 is the current supported release. Security fixes land on `main` and ship in tagged releases.

## Report a vulnerability

Do not open a public issue for a security-sensitive finding.

Use [GitHub private vulnerability reporting](https://github.com/codecapitano/pi-worktree/security/advisories/new). Include:

1. A description of the issue and its impact.
2. Steps to reproduce it or a proof of concept.
3. The affected commit or version, if known.
4. A suggested fix, if available.

## Scope

This extension invokes `git`, and invokes `gh` for pull requests, with the user's operating-system permissions. Worktrees are not sandboxes. A worktree can contain untrusted PR code and instruction files, and parent repository or conversation trust does not automatically make that content trusted.

Relevant reports include:

- unsafe command construction or argument injection;
- worktree removal that can destroy data;
- ambiguous, unsafe, or out-of-scope path selection;
- path traversal outside the intended worktree location;
- unsafe PR fetch or trust handling;
- session switching that bypasses persisted-session, idle, latest-leaf, or confirmation safeguards;
- shortcut configuration that writes outside the configured Pi agent directory;
- supply-chain issues in the repository or packed package.
