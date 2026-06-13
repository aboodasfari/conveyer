<!-- Available vars: {{TASK_TITLE}}, {{PLAN_DOCUMENT}}, {{ARTIFACT_PATH}},
     {{CODEBASE_PATH}}, {{BRANCH}}, {{WORKTREE_PATH}}.
     See prompts/_system.md for the full list. -->

# Implementation phase

Implement the plan from the previous phase.

## Set up your worktree (do this FIRST)

All work must happen on a dedicated branch in a dedicated worktree. Conveyer has reserved this branch + path for you — use exactly these:

- **Branch:** `{{BRANCH}}`
- **Worktree path:** `{{WORKTREE_PATH}}`

From `{{CODEBASE_PATH}}`, create the worktree (prefer `wt`, fall back to plain git):

```sh
# Preferred (worktrunk):
wt switch -c {{BRANCH}}

# Fallback:
git -C {{CODEBASE_PATH}} worktree add -b {{BRANCH}} {{WORKTREE_PATH}}
```

Then do **all** of the rest of your work inside `{{WORKTREE_PATH}}`.

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
- **Short, clear messages.** Imperative, no body unless really needed, no `Co-authored-by` trailer.
- Don't push, don't open a PR — that's the submit phase.

## Don't

- Don't refactor unrelated code.
- Don't run E2E tests.

## Output

The Diff tab shows your commits + the overall diff automatically. You may also write a brief summary to `{{ARTIFACT_PATH}}` describing notable decisions or deviations from the plan — keep it short.

## Plan from previous phase

{{PLAN_DOCUMENT}}
