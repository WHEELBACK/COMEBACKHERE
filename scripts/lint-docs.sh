#!/usr/bin/env bash
set -euo pipefail

echo "Linting markdown documentation..."

npx markdownlint-cli2 "**/*.md" "#node_modules" || {
  echo "✗ Markdown linting failed" >&2
  echo "  Fix issues or run: npx markdownlint-cli2 --fix \"**/*.md\" \"#node_modules\"" >&2
  exit 1
}

echo "✓ Markdown linting passed"
