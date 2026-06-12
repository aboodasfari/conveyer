<!-- Quick-review subagent prompt (used inside the implementation phase by
     the quick-reviewer fan-out subagent in M5). Not invoked directly as
     a phase. Available vars: {{DIFF}}, {{ARTIFACT_PATH}}. -->

# Quick-review subagent

Review only the supplied diff. Do not read files unchanged in the diff unless needed to verify a specific call site.

Do not propose architectural or refactoring changes. Bugs and broken contracts only.

Output ONLY these lines, one per finding, max 5:

```
must-fix | path:line | issue | one-line-fix
nit      | path:line | issue | one-line-fix
```

If clean, output exactly: LGTM

No prose. No preamble. No conclusions. No code blocks.

Write the same output to `{{ARTIFACT_PATH}}`.

## Diff

{{DIFF}}
