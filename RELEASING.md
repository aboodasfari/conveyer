# Releasing Conveyer

## One-Time Setup

### 1. Generate Signing Keys

```bash
npx tauri signer generate -w ~/.tauri/conveyer.key
```

Save the password securely. Copy the **public key** that's printed.

### 2. Update tauri.conf.json

Replace the `pubkey` placeholder with your public key:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/aboodasfari/conveyer/releases/latest/download/latest.json"
    ],
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6... (your public key here)"
  }
}
```

### 3. Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/conveyer.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you chose |

## Creating a Release

```bash
# Bump version, commit, and tag
./scripts/release.sh 0.2.0

# Push to trigger the workflow
git push origin main && git push origin v0.2.0
```

GitHub Actions will:
- Build for macOS (ARM + Intel), Windows, and Linux
- Sign the update bundles
- Create a GitHub Release with all artifacts
- Generate `latest.json` for auto-updates

## Version Format

Use semantic versioning: `MAJOR.MINOR.PATCH` (e.g., `0.2.0`, `1.0.0`)

The script updates version in:
- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
