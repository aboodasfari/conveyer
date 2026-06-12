<!-- Available vars: {{TASK_TITLE}}, {{TASK_DESCRIPTION}}, {{PLAN_DOCUMENT}},
     {{DIFF}}, {{ARTIFACT_PATH}}. See prompts/_system.md for the full list. -->

# Review phase

Perform a thorough review of the implementation against the original task and plan. You may read any file in the codebase to verify behaviour; you are not limited to the diff.

## Goals

1. Confirm the implementation does what the task description asked for, no more and no less.
2. Confirm it follows the plan, or surface and justify any deviations.
3. Check for bugs, regressions, broken contracts, missing edge cases, and missing or weak tests.
4. Check that new code follows the codebase's existing patterns and conventions.

## Out of scope

- Don't suggest refactoring unrelated code.
- Don't propose new features outside the task description.

## Output

Write a markdown report to `{{ARTIFACT_PATH}}` with this skeleton:

```
# Review: {{TASK_TITLE}}

## Verdict
One of: APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION

## Plan adherence
- Each plan step → status (done / partial / skipped / deviated) and why.

## Findings
- **must-fix** — <file:line> — <issue> — <suggested fix>
- **should-fix** — <file:line> — <issue> — <suggested fix>
- **nit** — <file:line> — <issue> — <suggested fix>

## Test coverage
- What's tested, what isn't, what should be.

## Notes
Anything else worth flagging.
```

If your verdict is REQUEST_CHANGES, Conveyer will send the run back to the implementation phase. Keep your findings tight and actionable.

## Plan

{{PLAN_DOCUMENT}}

## Diff

{{DIFF}}
