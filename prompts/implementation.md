<!-- Available vars: {{TASK_TITLE}}, {{PLAN_DOCUMENT}}, {{ARTIFACT_PATH}}.
     See prompts/_system.md for the full list. -->

# Implementation phase

Implement the plan from the previous phase. Make focused changes, commit nothing — Conveyer captures the diff for you.

## Goals

1. Apply the steps from the plan.
2. Add or update the tests called out in the plan.
3. Keep changes scoped to what the plan describes.

## Don't

- Don't refactor unrelated code.
- Don't run E2E tests.

## Output

Conveyer captures `git diff` automatically and shows it in the Diff tab. You may also write a brief summary to `{{ARTIFACT_PATH}}` describing notable decisions or deviations from the plan.

## Plan from previous phase

{{PLAN_DOCUMENT}}
