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
