# Project

## Repository layout

Canonical source trees:

- `packages/contracts/` — smart contracts
- `packages/backend/` — backend services
- `packages/frontend/` — web frontend

## Legacy tree migration (issue #951)

The top-level `contracts/`, `backend/`, and `frontend/` directories are legacy
trees scheduled for removal. All open pull requests that still modify these
legacy paths must be migrated to the canonical `packages/*` paths before the
legacy trees are deleted.

Migration checklist for open PRs:

1. Identify every open PR whose diff touches `contracts/`, `backend/`, or
   `frontend/`.
2. Rebase the PR onto the current default branch and port each changed file to
   its canonical replacement under `packages/contracts/`, `packages/backend/`,
   or `packages/frontend/` (preserving the relative path within the tree).
3. Drop any changes that only touch the legacy trees and have no canonical
   counterpart; note them in the PR description instead.
4. Confirm the PR diff no longer references the legacy trees, then merge.

Acceptance: no open PR targets a tree scheduled for removal.

## Handsoff notes

<!-- handsoff-issue-954 -->
- #954: Version contract storage schemas and test migrations
