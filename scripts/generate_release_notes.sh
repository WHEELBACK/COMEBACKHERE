#!/usr/bin/env bash
# generate_release_notes.sh — draft CHANGELOG.md entries from merged PR titles.
#
# Queries merged PRs since the last tag and groups them by conventional-commit prefix.
# Outputs a markdown section formatted for Keep a Changelog.
#
# Usage:
#   ./scripts/generate_release_notes.sh
#
# Environment variables (optional):
#   GITHUB_TOKEN — GitHub personal access token for higher rate limits
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Get the last tag or default to a reasonable starting point
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~50")

# Query merged PRs since last tag using gh CLI
echo "Querying merged PRs since $LAST_TAG..."
MERGED_PRS=$(gh pr list \
  --search "merged:>$(git log -1 --format=%ci "$LAST_TAG" | cut -d' ' -f1)" \
  --state merged \
  --limit 100 \
  --json title,number,mergedAt \
  --jq '.[] | "\(.number): \(.title)"' 2>/dev/null || echo "")

if [ -z "$MERGED_PRS" ]; then
  echo "No merged PRs found since $LAST_TAG"
  exit 0
fi

# Group by conventional-commit prefix
echo ""
echo "## Unreleased"
echo ""

declare -A sections
declare -a order=("feat" "fix" "perf" "docs" "style" "refactor" "test" "chore")

while IFS=: read -r number title; do
  number=$(echo "$number" | xargs)
  title=$(echo "$title" | xargs)
  
  # Extract conventional-commit prefix
  prefix=$(echo "$title" | sed -n 's/^\([a-z]*\).*/\1/p' || echo "chore")
  
  if [ -z "$prefix" ]; then
    prefix="chore"
  fi
  
  sections[$prefix]="${sections[$prefix]:-}- $title (#$number)
"
done <<< "$MERGED_PRS"

# Output grouped sections
for prefix in "${order[@]}"; do
  if [ -n "${sections[$prefix]:-}" ]; then
    case "$prefix" in
      feat)
        echo "### Added"
        ;;
      fix)
        echo "### Fixed"
        ;;
      perf)
        echo "### Performance"
        ;;
      docs)
        echo "### Documentation"
        ;;
      style)
        echo "### Changed"
        ;;
      refactor)
        echo "### Changed"
        ;;
      test)
        echo "### Testing"
        ;;
      chore)
        echo "### Maintenance"
        ;;
    esac
    echo ""
    echo "${sections[$prefix]}"
  fi
done

echo "Generated release notes. Edit CHANGELOG.md and adjust as needed."
