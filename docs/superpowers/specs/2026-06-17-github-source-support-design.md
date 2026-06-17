# GitHub source support — design

## Context

Conveyer pulls tasks from "sources". Today the only real source kind is
`ado` (Azure DevOps): a REST client (`src-tauri/src/ado/`) lists work items
assigned to `@me`, walks one parent hop to build the dashboard's
story → subtask tree, and upserts them as `tasks`. The submit phase already
creates PRs on **either** ADO or GitHub — the agent infers the remote from
git and the prompt already mentions `gh pr create`. So PR creation on GitHub
already works.

This adds GitHub as a **task source**, mirroring the ADO source so a user can
see GitHub issues assigned to them on the dashboard and tackle them.

## Decisions (made autonomously, mirroring ADO; revisit if undesired)

- **What it pulls:** open GitHub **issues** assigned to the authenticated
  user (`assignee:@me`). Pull requests are excluded (`is:issue`).
- **Scope:** a GitHub source is configured with an **owner** (org or user
  login, required) and an optional **repo**. We fetch all assigned issues via
  the Search API and keep those whose repository owner matches `owner` (and
  repo, if set). Filtering client-side avoids the GitHub `user:` vs `org:`
  qualifier ambiguity and works whether the owner is a user or an org.
- **Hierarchy:** GitHub issues are flat — no parent hop. Every issue is a
  top-level task (`parent_ref = NULL`). The dashboard already renders parentless
  tasks fine. (Sub-issues are a possible future enhancement.)
- **Auth:** two modes, mirroring ADO's entra/pat split:
  - `gh` (default): get a token via `gh auth token`. This reuses the user's
    existing GitHub CLI login (incl. SSO). Analogous to ADO's "Entra via az".
  - `pat`: read a token from a configured env var.
- **Client:** a `github` Rust module mirroring `ado`: reqwest against
  `api.github.com` with a `Bearer <token>` header. Kept separate and small.
- **No new dependencies.** Uses the existing reqwest + `gh` CLI already present.

## Components

### `src-tauri/src/github/auth.rs`
- `GithubAuthKind` { Gh, Pat } with `parse(&str)`.
- `token(kind, pat_env) -> AppResult<String>`:
  - `Gh` → run `gh auth token`, trim stdout. Clear error if `gh` missing/not
    logged in.
  - `Pat` → read env var `pat_env`.
- Returns the raw token; the client adds the `Bearer ` prefix.

### `src-tauri/src/github/mod.rs`
- `GithubSourceConfig { owner: String, repo: Option<String>, host: Option<String> }`.
- `api_base(host)` builds the REST base URL: `https://api.github.com` for
  public GitHub, `https://api.<sub>.ghe.com` for data residency, and
  `https://<host>/api/v3` for a self-hosted GitHub Enterprise Server. Host is
  normalised (scheme/trailing-slash stripped; github.com → public).
- `GithubIssue { number, repo_full_name, title, state, body, html_url }`.
- `source_ref(issue) -> String` = `"{repo_full_name}#{number}"` (stable, unique
  per source).
- `fetch_assigned_issues(cfg, token) -> Vec<GithubIssue>`:
  Search API `GET /search/issues?q=assignee:@me is:issue is:open`, paginated
  (cap ~5 pages × 100 = 500). Filter items by `cfg.owner` (and `cfg.repo`).
- `fetch_issue(token, owner, repo, number) -> GithubIssue` for add-by-url.
- `ping(cfg, token)`: `GET /user` to validate the token; if `cfg.repo` is set,
  also `GET /repos/{owner}/{repo}` to validate access.
- `extract_issue_ref(url) -> Option<(owner, repo, number)>` parsing
  `https://github.com/<owner>/<repo>/issues/<n>` (+ unit tests).

### Wiring (mirror the ADO branches)
- `commands/sources.rs::sources_test` — add a `kind == "github"` branch.
- `commands/tasks.rs::tasks_refresh` — add a `github` branch: fetch assigned
  issues, upsert as flat tasks (`is_self_assigned = 1`, `parent_ref = NULL`).
- `commands/tasks.rs::tasks_add_by_url` — detect a GitHub issue URL and route
  to the github path; keep the ADO path otherwise.
- `models.rs` — add `GithubSourceConfig`. `Source.auth_kind` already a free
  string, so it stores `gh`/`pat` without a schema change.
- No DB migration: `sources` already has `kind`, `config_json`, `pat_env`,
  `auth_kind`, `az_account` (the last unused for GitHub).

### Frontend (`src/pages/Settings.tsx`)
- Source-kind step: add a **GitHub** radio next to Azure DevOps.
- A GitHub form: Name, Owner (required), Repo (optional), Auth
  (GitHub CLI / PAT). On PAT, show the env-var field. Reuse the existing
  test+save flow (`sourceTest` then `sourceUpsert`).
- `src/types.ts` — add `GithubSourceConfig`; widen `AuthKind` to include `gh`.

## Data flow

```
Add GitHub source (owner, repo?, auth)
        │  sources_test → github::ping
        ▼
sources_upsert (kind='github', config_json={owner,repo}, auth_kind='gh'|'pat')
        │
Refresh ──► tasks_refresh(github branch)
        │      github::fetch_assigned_issues → filter by owner/repo
        ▼
   upsert tasks (source_ref="owner/repo#n", flat, self-assigned)
        │
Dashboard lists them ──► Tackle ──► existing run pipeline
        │                                   │
        └──────────── submit phase creates the PR via `gh` (already works)
```

## Error handling

- `gh` missing / not logged in → actionable message ("Run `gh auth login`").
- PAT env var unset → same pattern as ADO ("env var X not set").
- Non-success HTTP → surface GitHub's JSON `message` (e.g. rate limit, 422),
  mirroring the ADO `check`/`excerpt` helper.

## Testing

- Unit: `extract_issue_ref` URL parsing; `source_ref` formatting; owner/repo
  client-side filter. (Network calls aren't unit-tested, same as ADO.)
- Build: `cargo test`, `cargo check`, `tsc`, `npm run build`, `node --check`.
- Manual: add a GitHub source for a repo with an assigned issue, refresh, see
  it on the dashboard.

## Out of scope (future)

- Owner/org-wide scoping via a single qualifier; sub-issue hierarchy; pulling
  PRs as tasks; webhooks/live updates.

GitHub Enterprise hosts ARE supported via the source `host` field (public
GitHub, `*.ghe.com` data residency, and self-hosted GHES `/api/v3`); the gh
token is fetched per-host via `gh auth token --hostname`.
