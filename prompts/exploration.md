<!-- Available vars: {{TASK_TITLE}}, {{TASK_STATE}}, {{TASK_DESCRIPTION}},
     {{PARENT_TITLE}}, {{PARENT_DESCRIPTION}}, {{CODEBASE_PATH}},
     {{ARTIFACT_PATH}}. See prompts/_system.md for the full list. -->

# Exploration phase

Research the task and the relevant parts of the codebase. Produce a context document that will inform the planning phase.

## Relevant skills

- `systematic-debugging` — if the task is fixing a bug, follow this before forming hypotheses.
- `dispatching-parallel-agents` — for breadth-first investigation across many independent areas.

## Goals

1. Identify the files, modules, or systems that this task touches.
2. Capture any relevant existing patterns, conventions, or constraints.
3. Surface ambiguities, open questions, or risks.
4. Note any blockers that would prevent moving on to planning.

## Don't

- Don't propose a plan yet — that's the next phase.
- Don't make code changes.

## Context document format

Write a concise markdown document to `{{ARTIFACT_PATH}}` with these sections:

```
# Context: {{TASK_TITLE}}

## Affected areas
- ...

## Existing patterns and constraints
- ...

## Open questions
- ...

## Risks
- ...
```
