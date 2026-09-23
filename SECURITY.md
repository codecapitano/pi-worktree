# Security policy

## Supported versions

The fork has not published a supported release. Security fixes land on `main` while the initial review is in progress.

## Report a vulnerability

Do not open a public issue for a security-sensitive finding.

Use [GitHub private vulnerability reporting](https://github.com/codecapitano/pi-worktree/security/advisories/new). Include:

1. A description of the issue and its impact.
2. Steps to reproduce it or a proof of concept.
3. The affected commit or version, if known.
4. A suggested fix, if available.

## Scope

This Pi extension runs `git` and `gh` with the user's operating-system permissions. Relevant reports include:

- unsafe command construction or argument injection;
- worktree removal that can destroy data;
- ambiguous or unsafe path selection;
- path traversal outside the intended worktree location;
- supply-chain issues in the repository or packed package.
