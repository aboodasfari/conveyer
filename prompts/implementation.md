<!-- Available vars: {{TASK_TITLE}}, {{PLAN_DOCUMENT}}, {{ARTIFACT_PATH}},
     {{CODEBASE_PATH}}, {{BRANCH}}, {{WORKTREE_PATH}}.
     See prompts/_system.md for the full list. -->

# Implementation phase

Implement the plan from the previous phase.

## Your workspace

Conveyer has already created a dedicated worktree for you. You are starting in it:

- **Branch:** `{{BRANCH}}`
- **Worktree:** `{{WORKTREE_PATH}}`

All your file reads, edits, and `git` commands should operate on this worktree. Do **not** create another worktree, switch branches, or touch the original checkout at `{{CODEBASE_PATH}}`.

## Relevant skills

- `executing-plans` — follow this to work through the plan step by step.
- `test-driven-development` — for any new behaviour, write the test first.
- `subagent-driven-development` — for independent tasks that can be parallelised.

## Goals

1. Apply the steps from the plan.
2. Add or update the tests called out in the plan.
3. Keep changes scoped to what the plan describes.

## Commits

- **Commit your work.** Conveyer's Diff tab reads `git diff` between the branch's base and HEAD, plus per-commit diffs.
- **Split into logical commits.** Each commit should be one coherent change (e.g. "add helper", "wire helper into API", "test for helper"). Don't pile everything into one giant commit.
- **Short, clear messages.** Imperative, no body unless really needed, **no `Co-authored-by` trailer**.
- Don't push, don't open a PR — that's the submit phase.

## Don't

- Don't refactor unrelated code.
- Don't run E2E tests.

## Output

The Diff tab shows your commits + the overall diff automatically. You may also write a brief summary to `{{ARTIFACT_PATH}}` describing notable decisions or deviations from the plan — keep it short.

## Plan from previous phase

{{PLAN_DOCUMENT}}
