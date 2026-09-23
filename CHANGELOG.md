# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [1.2.2](https://github.com/codecapitano/pi-worktree/compare/pi-worktree-v1.2.1...pi-worktree-v1.2.2) - 2026-09-23

### Security

- Refuse non-interactive and forced worktree removal.
- Require exact branch or path matches for removal.
- Reject invalid branch names before invoking fetch or worktree commands.
- Verify a fetched pull request head before reusing a local branch.
- Resolve pull request metadata and Git refs against the same `origin` repository.
- Stop branch creation when remote discovery or fetch fails.

### Changed

- Add unit and temporary-repository integration tests.
- Remove development dependencies and install-time hooks.
- Pin GitHub Actions to immutable commit SHAs.

## [1.2.1](https://github.com/thisuxhq/pi-worktree/compare/pi-worktree-v1.2.0...pi-worktree-v1.2.1) (2026-07-21)


### Documentation

* add THISUX community health files and MIT license ([4300a5b](https://github.com/thisuxhq/pi-worktree/commit/4300a5beda3d68bbb159c4eb093d36ada76729e8))

## [1.2.0](https://github.com/thisuxhq/pi-worktree/releases/tag/pi-worktree-v1.2.0) - 2026-07-21

### Added

- Git worktree slash commands for Pi (`/worktree` ls|add|open|rm|pr)
- THISUX community health pack (Contributing, CoC, Security, issue/PR templates, CITATION.cff)
- MIT license under THISUX Private Limited
