# Conveyer

A desktop app that orchestrates AI coding agents through structured, phased workflows on your Azure DevOps and GitHub tasks.

## Features

- **Phased development** — Break tasks into exploration, planning, implementation, review, and submit phases with human checkpoints
- **Multiple agent backends** — Works with GitHub Copilot coding agents
- **Azure DevOps & GitHub integration** — Pull work items and issues directly from your boards
- **Auto-updates** — Get notified when new versions are available and update with one click

## Download

Grab the latest release for your platform from the [Releases](https://github.com/aboodasfari/conveyer/releases) page:

- **macOS** — `.dmg` installer (`aarch64` for Apple Silicon, `x64` for Intel)
- **Windows** — `.exe` installer (NSIS) or `.msi`
- **Linux** — `.AppImage`, `.deb`, or `.rpm`

> **macOS note:** The app is not code-signed or Apple-notarized (that requires a paid
> Apple Developer account). macOS quarantines downloaded unsigned apps, so on first launch
> you may see **"Conveyer is damaged and can't be opened."** This is Gatekeeper, not actual
> corruption. To fix it, drag Conveyer into **Applications**, then run this once in Terminal:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/Conveyer.app
> ```
>
> Then open the app normally. (On Apple Silicon, right-click → Open does **not** clear the
> "damaged" state — the `xattr` command above is required.)

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
