# Conveyer

Tauri app that orchestrates Copilot agents through phased work on Azure DevOps tasks.

## Stack
React + TypeScript (Vite) · Tauri 2 (Rust) · SQLite (sqlx) · Primer React + Octicons.

## Develop

Requirements: Node ≥20, Rust stable (via `rustup`).

```sh
npm install
npm run tauri dev
```

Set your ADO PAT in an env var (default name `ADO_PAT`) before launching, then add a source under Settings.

## Build

```sh
npm run tauri build           # full installer
npm run tauri build -- --no-bundle  # just the binary
```

## Layout

- `src-tauri/` — Rust core: db, IPC commands, ADO client.
- `src/` — React UI (pages, components, typed `api.ts` wrappers).
- Local DB lives at `~/Library/Application Support/conveyer/conveyer.db` (override with `CONVEYER_DB`).

See the design + roadmap in `vaults/Abood Microsoft/conveyer/`.

## Releasing

Conveyer ships updates via the Tauri 2 updater plugin, pointed at the latest GitHub Release on `aboodasfari/conveyer`. Installed clients poll on launch, then once every 24h (and on window focus, throttled to 1h), and surface an update icon in the header.

### One-time setup

1. Generate a signing keypair:
   ```sh
   npm run tauri signer generate -- -w ~/.tauri/conveyer.key
   ```
2. **Back up the private key and password** (e.g. 1Password). If the private key is lost, you cannot publish further updates to existing installs — they will reject mismatched signatures forever.
3. Copy the public key into `src-tauri/tauri.conf.json` at `plugins.updater.pubkey` (replace `REPLACE_WITH_TAURI_UPDATER_PUBKEY`) and commit.

### Per release

1. Bump the version in **all three** places:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Build with the signing env vars set so `.sig` sidecars are produced:
   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/conveyer.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."
   npm run tauri build
   ```
   `bundle.createUpdaterArtifacts: true` is already set in `tauri.conf.json`; confirm `.sig` files appear next to the bundles (macOS `.app.tar.gz`, Windows NSIS `.exe`).
3. Create a GitHub Release and upload:
   - macOS: `Conveyer.app.tar.gz` + `Conveyer.app.tar.gz.sig`
   - Windows: `Conveyer_<version>_x64-setup.exe` + `.sig` (the NSIS bundle — not the MSI)
   - `latest.json` (template below)

### `latest.json` template

```json
{
  "version": "0.2.0",
  "notes": "Short release notes shown in the in-app dialog.",
  "pub_date": "2025-01-01T12:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "signature": "<contents of .sig file>",
      "url": "https://github.com/aboodasfari/conveyer/releases/download/v0.2.0/Conveyer.app.tar.gz"
    },
    "darwin-aarch64": {
      "signature": "<contents of .sig file>",
      "url": "https://github.com/aboodasfari/conveyer/releases/download/v0.2.0/Conveyer.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "<contents of .sig file>",
      "url": "https://github.com/aboodasfari/conveyer/releases/download/v0.2.0/Conveyer_0.2.0_x64-setup.exe"
    }
  }
}
```

The endpoint `https://github.com/aboodasfari/conveyer/releases/latest/download/latest.json` always resolves to the newest release's asset, so no further config changes are required between releases.

> macOS note: builds are not Apple-notarized, so first-run Gatekeeper warnings still apply. The updater itself works regardless.
