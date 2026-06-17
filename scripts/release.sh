#!/bin/bash
# Usage: ./scripts/release.sh 0.2.0
# Bumps version in all config files, commits, and creates a git tag

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.0"
  exit 1
fi

VERSION="$1"
TAG="v$VERSION"

echo "🚀 Releasing version $VERSION..."

# Update package.json
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json && rm package.json.bak
echo "✓ Updated package.json"

# Update tauri.conf.json  
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json && rm src-tauri/tauri.conf.json.bak
echo "✓ Updated tauri.conf.json"

# Update Cargo.toml (only the package version, not dependencies)
sed -i.bak '0,/^version = "[^"]*"/{s/^version = "[^"]*"/version = "'"$VERSION"'"/}' src-tauri/Cargo.toml && rm src-tauri/Cargo.toml.bak
echo "✓ Updated Cargo.toml"

# Update Cargo.lock
cd src-tauri && cargo generate-lockfile && cd ..
echo "✓ Updated Cargo.lock"

# Commit and tag
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: release v$VERSION"
git tag -a "$TAG" -m "Release $TAG"

echo ""
echo "✅ Version bumped to $VERSION and tagged as $TAG"
echo ""
echo "To trigger the release workflow, push the tag:"
echo "  git push origin main && git push origin $TAG"
