#!/usr/bin/env node
/**
 * Conveyer phase runner sidecar.
 *
 * Spawned by the Rust core once per phase. Communicates by emitting
 * NDJSON events on stdout. The Rust core persists them to SQLite and
 * forwards as Tauri events to the UI.
 *
 * Event types:
 *   {"type":"message","role":"assistant"|"tool"|"system","content":"..."}
 *   {"type":"artifact","path":"..."}                 // absolute path
 *   {"type":"needs_input","prompt":"...","kind":"open"|"multi","choices":[...]}
 *   {"type":"done","ok":true}                        // success → phase advances
 *   {"type":"done","ok":false,"error":"..."}         // failure → phase fails
 *
 * Configuration via env:
 *   CONVEYER_PHASE         exploration | planning | implementation | review | submit
 *   CONVEYER_TASK_ID
 *   CONVEYER_TASK_TITLE
 *   CONVEYER_TASK_STATE
 *   CONVEYER_TASK_DESCRIPTION
 *   CONVEYER_PARENT_TITLE     (optional)
 *   CONVEYER_RUN_ID
 *   CONVEYER_CODEBASE_PATH
 *   CONVEYER_PROMPTS_DIR
 *   CONVEYER_ARTIFACT_PATH    (absolute file path the agent should write to)
 *   CONVEYER_CONTEXT_DOC      (file path to previous phase's artifact, when relevant)
 *   CONVEYER_PLAN_DOC         (file path to planning artifact, when relevant)
 *   CONVEYER_BACKEND          "stub" (default) | "copilot"
 */

import fs from "node:fs/promises";
import path from "node:path";

const env = process.env;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function msg(role, content) {
  emit({ type: "message", role, content });
}

async function readFileOr(filePath, fallback = "") {
  if (!filePath) return fallback;
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

/**
 * Render a Mustache-ish template by substituting {{KEY}} with values.
 * Also strips/expands the very simple {{#KEY}}…{{/KEY}} conditional used
 * in _system.md for optional parent.
 */
function renderTemplate(tpl, vars) {
  // {{#KEY}}…{{/KEY}} — keep only if KEY is truthy.
  tpl = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, body) =>
    vars[k] ? body : "",
  );
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : "",
  );
}

async function buildPrompt(phase) {
  const promptsDir = env.CONVEYER_PROMPTS_DIR;
  const system = await readFileOr(path.join(promptsDir, "_system.md"));
  const phaseTpl = await readFileOr(path.join(promptsDir, `${phase}.md`));

  const vars = {
    TASK_TITLE: env.CONVEYER_TASK_TITLE || "",
    TASK_STATE: env.CONVEYER_TASK_STATE || "",
    TASK_DESCRIPTION: env.CONVEYER_TASK_DESCRIPTION || "",
    PARENT_TITLE: env.CONVEYER_PARENT_TITLE || "",
    CODEBASE_PATH: env.CONVEYER_CODEBASE_PATH || "",
    ARTIFACT_PATH: env.CONVEYER_ARTIFACT_PATH || "",
    CONTEXT_DOCUMENT: await readFileOr(env.CONVEYER_CONTEXT_DOC, "(no context document)"),
    PLAN_DOCUMENT: await readFileOr(env.CONVEYER_PLAN_DOC, "(no plan document)"),
    DIFF: "(diff capture wires up alongside the implementation phase)",
  };

  return renderTemplate(system, vars) + "\n\n---\n\n" + renderTemplate(phaseTpl, vars);
}

/* -------------------------------------------------------------------------- */
/*                              Backend: stub                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pretends to be the agent. Streams a couple of messages, writes a
 * placeholder artifact, exits cleanly. Lets us validate the streaming
 * end-to-end without the real SDK in the loop.
 */
async function runStub(phase, prompt) {
  msg("system", `Conveyer stub backend: starting ${phase}`);
  await sleep(400);

  msg("assistant", "Reading the task description and codebase…");
  await sleep(600);
  msg("tool", `(stub) would run: ls ${env.CONVEYER_CODEBASE_PATH}`);
  await sleep(600);

  msg("assistant", `Producing the ${phase} artifact.`);
  const body = stubArtifact(phase, prompt);
  await writeArtifact(body);
  await sleep(400);

  msg("assistant", "Done.");
  emit({ type: "done", ok: true });
}

function stubArtifact(phase, prompt) {
  const title = env.CONVEYER_TASK_TITLE || "(untitled)";
  switch (phase) {
    case "exploration":
      return `# Context: ${title}\n\n## Affected areas\n- (stub) src/example.ts\n\n## Existing patterns and constraints\n- (stub) follow existing module pattern\n\n## Open questions\n- (stub) none\n\n## Risks\n- (stub) low\n\n---\n\n<details><summary>Rendered prompt</summary>\n\n\`\`\`\n${prompt.slice(0, 2000)}\n\`\`\`\n\n</details>\n`;
    case "planning":
      return `# Plan: ${title}\n\n## Approach\n(stub) One-paragraph approach.\n\n## Steps\n1. **Sketch the change** — files: \`src/example.ts\` — change: add a function — verify: \`npm test\`\n2. **Wire it up** — files: \`src/index.ts\` — change: export it — verify: build\n\n## Tests to add or update\n- (stub) add unit test for the new function\n`;
    case "implementation":
      return `# Implementation summary: ${title}\n\n(stub) No real changes made. In M4b, the real agent's diff will appear in the Diff tab; this document captures any notable decisions.\n`;
    case "review":
      return `LGTM\n`;
    case "submit":
      return `# Pull Request\n\nURL: (stub - no PR opened)\n\n## Checks\n- (stub): not run\n`;
    default:
      return `# ${phase}\n\n(stub artifact)`;
  }
}

/* -------------------------------------------------------------------------- */
/*                            Backend: copilot                                */
/* -------------------------------------------------------------------------- */

/**
 * Real Copilot SDK call. Swap the body of `runCopilot` for the actual
 * SDK invocation when you've decided which npm package you're using.
 * The Rust core picks this backend when env CONVEYER_BACKEND=copilot.
 *
 * Required event protocol stays the same.
 */
async function runCopilot(phase, prompt) {
  msg("system", "Copilot backend not configured yet — see sidecar/conveyer-agent.mjs runCopilot()");
  // TODO(m4b): plug in @github/copilot or @anthropic-ai/sdk equivalent here.
  // For now, fall back to the stub so the rest of the system keeps working.
  await runStub(phase, prompt);
}

/* -------------------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function writeArtifact(body) {
  const p = env.CONVEYER_ARTIFACT_PATH;
  if (!p) return;
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf8");
  emit({ type: "artifact", path: p });
}

async function main() {
  const phase = env.CONVEYER_PHASE;
  if (!phase) {
    emit({ type: "done", ok: false, error: "CONVEYER_PHASE not set" });
    process.exit(1);
  }
  let prompt = "";
  try {
    prompt = await buildPrompt(phase);
  } catch (e) {
    emit({ type: "done", ok: false, error: `Failed to build prompt: ${e?.message ?? e}` });
    process.exit(1);
  }

  const backend = env.CONVEYER_BACKEND || "stub";
  try {
    if (backend === "copilot") {
      await runCopilot(phase, prompt);
    } else {
      await runStub(phase, prompt);
    }
  } catch (e) {
    emit({ type: "done", ok: false, error: e?.message ?? String(e) });
    process.exit(1);
  }
}

main().catch((e) => {
  emit({ type: "done", ok: false, error: e?.message ?? String(e) });
  process.exit(1);
});
