# Conveyer

A desktop app that orchestrates AI coding agents through structured, phased workflows on your Azure DevOps and GitHub tasks.

## Features

- **Phased development** — Break tasks into exploration, planning, implementation, review, and submit phases with human checkpoints
- **Multiple agent backends** — Works with GitHub Copilot coding agents
- **Azure DevOps & GitHub integration** — Pull work items and issues directly from your boards
- **Auto-updates** — Get notified when new versions are available and update with one click

## Download

Grab the latest release for your platform from the [Releases](https://github.com/aboodasfari/conveyer/releases) page:

- **macOS** — `.dmg` installer
- **Windows** — `.exe` installer (NSIS)
- **Linux** — `.AppImage` or `.deb`

> **macOS note:** The app is not Apple-notarized. On first launch, right-click → Open to bypass Gatekeeper.

## Getting Started

1. Launch Conveyer
2. Go to **Settings** and add a source (Azure DevOps or GitHub)
3. For ADO: set your PAT in an environment variable (default `ADO_PAT`) before launching
4. Tasks from your configured sources appear on the dashboard

## Development

Requirements: Node ≥20, Rust stable (via `rustup`).

```sh
npm install
npm run tauri dev
```

See [RELEASING.md](RELEASING.md) for maintainer docs on publishing new versions.

## License

MIT
