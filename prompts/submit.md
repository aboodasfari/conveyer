<!-- Available vars: {{TASK_TITLE}}, {{BRANCH}}, {{WORKTREE_PATH}}.
     See prompts/_system.md for the full list. -->

# Submit phase

Propose the pull request for the work on branch `{{BRANCH}}` (worktree: `{{WORKTREE_PATH}}`).
{{#TASK_REF}}

This task came from a **{{SOURCE_KIND}}** source. Its work item / issue is:

- **Ref:** `{{TASK_REF}}`
- **URL:** {{TASK_URL}}

Always link this work item / issue to the PR (see the linking rules below) so the
PR and the originating task stay connected.
{{/TASK_REF}}

## Important: propose, do not create yet

In this phase you only **draft** the PR. Do NOT push or run `az repos pr create` /
`gh pr create`. Conveyer shows your proposal to the user as a PR preview; once they
approve, you'll be asked (in a follow-up) to actually create it.

## Steps

1. Inspect the commits and diff on this branch so the proposal is accurate.
2. {{#TARGET_BRANCH}}The PR's target branch is **`{{TARGET_BRANCH}}`** — set by
   the user on this task. Use it directly; do not re-detect.{{/TARGET_BRANCH}}{{^TARGET_BRANCH}}Determine the target branch from the remote's default branch
   (e.g. `git remote show origin` -> "HEAD branch").{{/TARGET_BRANCH}}
3. Draft a clear PR title (usually the task title `{{TASK_TITLE}}`) and a markdown
   description: a short summary plus a checklist of what changed, taken from the
   implementation. Use the repo's PR template if one exists.{{#WORKING_BRANCH}} The
   PR is opened from the existing branch **`{{WORKING_BRANCH}}`** (no new branch
   was created for this task).{{/WORKING_BRANCH}}
{{#TASK_REF}}
4. Reference the originating work item / issue `{{TASK_REF}}` in the description per
   the linking rules below, so the preview shows the link.
5. Call the **`propose_pr`** tool with the title, target branch, description, any
   suggested reviewers, and the work item / issue ref `{{TASK_REF}}` in `work_items`.
{{/TASK_REF}}
{{^TASK_REF}}
4. Call the **`propose_pr`** tool with the title, target branch, description, and any
   suggested reviewers or linked work items you can infer.
{{/TASK_REF}}

Then stop. Do not create the PR.

{{#TASK_REF}}
## Linking rules

How you attach the work item / issue depends on the source:

- **GitHub** (`{{TASK_REF}}` looks like `owner/repo#123`): add a closing keyword to
  the PR description so GitHub auto-links and closes the issue when the PR merges —
  e.g. `Closes #123` if the PR targets the same repo, or `Closes owner/repo#123`
  for a cross-repo reference. Also pass the ref in `propose_pr`'s `work_items`.
- **Azure DevOps** (`{{TASK_REF}}` is a numeric work item id): when you create the PR
  later, link the work item with `az repos pr create --work-items {{TASK_REF}}`
  (or `az repos pr work-item add` afterwards). Mentioning `#{{TASK_REF}}` in the
  description does not reliably link it, so use `--work-items`. Pass the id in
  `propose_pr`'s `work_items` too.

{{/TASK_REF}}
## When asked to create it (later turn)

After the user approves, you'll be told to create the PR. At that point:

1. Push the branch `{{BRANCH}}` to the remote if needed.
2. Create a **draft** PR from `{{BRANCH}}` into the target branch with the proposed
   title and description.
{{#TASK_REF}}
3. Link the work item / issue `{{TASK_REF}}` using the source-specific method in the
   linking rules above (GitHub closing keyword in the body; ADO `--work-items`).
4. Best-effort: queue the required policy/build checks but do NOT wait or poll for
   them. If you can't queue them, just note it.
5. Call the **`pr_created`** tool with the PR number, URL, status (`created` or
   `failed`), and the checks you queued.
{{/TASK_REF}}
{{^TASK_REF}}
3. Best-effort: queue the required policy/build checks but do NOT wait or poll for
   them. If you can't queue them, just note it.
4. Call the **`pr_created`** tool with the PR number, URL, status (`created` or
   `failed`), and the checks you queued.
{{/TASK_REF}}
