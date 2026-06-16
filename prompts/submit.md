<!-- Available vars: {{TASK_TITLE}}, {{BRANCH}}, {{WORKTREE_PATH}}.
     See prompts/_system.md for the full list. -->

# Submit phase

Propose the pull request for the work on branch `{{BRANCH}}` (worktree: `{{WORKTREE_PATH}}`).

## Important: propose, do not create yet

In this phase you only **draft** the PR. Do NOT push or run `az repos pr create` /
`gh pr create`. Conveyer shows your proposal to the user as a PR preview; once they
approve, you'll be asked (in a follow-up) to actually create it.

## Steps

1. Inspect the commits and diff on this branch so the proposal is accurate.
2. Determine the target branch from the remote's default branch
   (e.g. `git remote show origin` -> "HEAD branch").
3. Draft a clear PR title (usually the task title `{{TASK_TITLE}}`) and a markdown
   description: a short summary plus a checklist of what changed, taken from the
   implementation. Use the repo's PR template if one exists.
4. Call the **`propose_pr`** tool with the title, target branch, description, and any
   suggested reviewers or linked work items you can infer.

Then stop. Do not create the PR.

## When asked to create it (later turn)

After the user approves, you'll be told to create the PR. At that point:

1. Push the branch `{{BRANCH}}` to the remote if needed.
2. Create a **draft** PR from `{{BRANCH}}` into the target branch with the proposed
   title and description.
3. Best-effort: queue the required policy/build checks but do NOT wait or poll for
   them. If you can't queue them, just note it.
4. Call the **`pr_created`** tool with the PR number, URL, status (`created` or
   `failed`), and the checks you queued.
