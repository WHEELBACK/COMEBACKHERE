# Pull Request

## Summary

- Describe the purpose of this PR in one or two sentences.

## Checklist

- [ ] PR description includes: Closes #[issue_id]
- [ ] Changes target canonical paths only (no edits under legacy `contracts/`, `backend/`, or `frontend/` trees)
- [ ] Tests added or updated
- [ ] ABI snapshot updated if contract sources changed (`abis/` and `COMEBACKHERE-contracts/`)
- [ ] Screenshots attached if UI changed
- [ ] Documentation updated if needed

## Notes

- Legacy `contracts/`, `backend/`, and `frontend/` trees are scheduled for removal. Port any changes to the canonical replacement paths before opening or updating a PR.
- For contract changes, verify ABI snapshot hygiene with `make check-abi-snapshots`.
- For UI changes, include screenshots or screen recordings to help reviewers.
