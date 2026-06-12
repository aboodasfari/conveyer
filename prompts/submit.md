<!-- Available vars: {{TASK_TITLE}}, {{ARTIFACT_PATH}}.
     See prompts/_system.md for the full list. -->

# Submit phase

Open a draft pull request for the work in this branch.

## Goals

1. Push the current branch to the remote (use the same name as the local branch).
2. Open a **draft** pull request against the default branch using the repository's PR template if one exists, else a minimal body.
3. Run all required checks.

## PR body

- Title: the task title (`{{TASK_TITLE}}`)
- Body: a short summary referencing the task and a checklist of what was changed (taken from the implementation summary).

## Output

Write the PR URL and the status of any kicked-off checks to `{{ARTIFACT_PATH}}` as:

```
# Pull Request

URL: <url>

## Checks
- <check-name>: <status>
```
