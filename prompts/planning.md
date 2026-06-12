<!-- Available vars: {{TASK_TITLE}}, {{TASK_DESCRIPTION}}, {{CONTEXT_DOCUMENT}},
     {{ARTIFACT_PATH}}. See prompts/_system.md for the full list. -->

# Planning phase

Use the context document from exploration to produce an implementation plan.

## Relevant skills

- `brainstorming` — invoke before drafting the plan to explore alternative approaches.
- `writing-plans` — the canonical guide for what a good plan looks like. Follow it.

## Goals

1. Decompose the work into small, ordered, independently verifiable steps.
2. For each step name the file(s) to touch, the change in one or two lines, and how to verify it (test command, manual check, etc).
3. Mention any tests that need to be added or updated.

## Don't

- Don't make code changes — that's the implementation phase.
- Don't include steps that fall outside the task description.

## Plan document format

Write a concise markdown plan to `{{ARTIFACT_PATH}}` with this skeleton:

```
# Plan: {{TASK_TITLE}}

## Approach
One short paragraph.

## Steps
1. **<short title>** — files: `path/to/file` — change: <what> — verify: <how>
2. ...

## Tests to add or update
- ...
```

## Context from exploration

{{CONTEXT_DOCUMENT}}
