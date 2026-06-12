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
 *   CONVEYER_PARENT_TITLE        (optional)
 *   CONVEYER_PARENT_DESCRIPTION  (optional)
 *   CONVEYER_RUN_ID
 *   CONVEYER_CODEBASE_PATH
 *   CONVEYER_PROMPTS_DIR
 *   CONVEYER_ARTIFACT_PATH    (absolute file path the agent should write to)
 *   CONVEYER_CONTEXT_DOC      (file path to previous phase's artifact, when relevant)
 *   CONVEYER_PLAN_DOC         (file path to planning artifact, when relevant)
 *   CONVEYER_BACKEND          "copilot" (default) | "stub"
 *   CONVEYER_COPILOT_MODEL    optional model override (default: gpt-5.1)
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
    PARENT_DESCRIPTION: env.CONVEYER_PARENT_DESCRIPTION || "",
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
 * Real Copilot SDK call. Uses @github/copilot-sdk to spawn the bundled
 * Copilot CLI in server mode, creates a streaming session anchored at
 * CONVEYER_CODEBASE_PATH, sends the rendered prompt, and forwards the
 * agent's deltas and tool invocations to Conveyer over our NDJSON
 * protocol.
 *
 * Auth: the SDK reuses the user's existing `copilot` CLI auth. They've
 * already run `gh auth login` / `copilot auth` for the standalone CLI;
 * no extra setup needed here.
 *
 * Approval: we auto-approve every permission for now. M5 will add a
 * "needs_input" round-trip to surface tool-call confirmations in the UI.
 */
async function runCopilot(phase, prompt) {
  let CopilotClient, approveAll;
  try {
    ({ CopilotClient, approveAll } = await import("@github/copilot-sdk"));
  } catch (e) {
    msg("system", `@github/copilot-sdk not installed: ${e?.message ?? e}`);
    emit({ type: "done", ok: false, error: "Install @github/copilot-sdk in the conveyer package." });
    return;
  }

  const client = new CopilotClient();
  let session;
  try {
    await client.start?.();
    session = await client.createSession({
      model: env.CONVEYER_COPILOT_MODEL || "gpt-5.1",
      streaming: true,
      workingDirectory: env.CONVEYER_CODEBASE_PATH || process.cwd(),
      onPermissionRequest: approveAll ?? (() => ({ decision: "approve_once" })),
    });
  } catch (e) {
    msg("system", `Failed to start Copilot SDK: ${e?.message ?? e}`);
    try { await client.stop?.(); } catch { /* noop */ }
    emit({ type: "done", ok: false, error: e?.message ?? String(e) });
    return;
  }

  // Buffer streaming deltas; flush as a single "assistant" message on each
  // assistant.message (so we don't spam the UI with thousands of tiny rows).
  let buffer = "";
  const flush = () => {
    if (buffer.length === 0) return;
    msg("assistant", buffer);
    buffer = "";
  };

  const unsubscribe = session.on((event) => {
    switch (event.type) {
      case "assistant.message_delta":
        if (event.data?.deltaContent) buffer += event.data.deltaContent;
        break;
      case "assistant.message":
        flush();
        break;
      case "assistant.reasoning":
        if (event.data?.content) msg("system", `[thinking] ${event.data.content}`);
        break;
      case "tool.execution_start":
        msg("tool", `→ ${event.data?.toolName ?? "tool"}${event.data?.input ? ": " + truncate(JSON.stringify(event.data.input), 240) : ""}`);
        break;
      case "tool.execution_complete":
        if (event.data?.error) {
          msg("tool", `← ${event.data?.toolName ?? "tool"} failed: ${event.data.error}`);
        } else if (event.data?.output !== undefined) {
          msg("tool", `← ${event.data?.toolName ?? "tool"}: ${truncate(stringifyOutput(event.data.output), 240)}`);
        }
        break;
      case "session.error":
        msg("system", `[error] ${event.data?.message ?? JSON.stringify(event.data)}`);
        break;
      // Everything else we ignore for the wire log — too chatty.
      default:
        break;
    }
  });

  try {
    await session.sendAndWait({ prompt });
    flush();
    // Capture the artifact file the agent (hopefully) wrote.
    await checkArtifactWritten();
    emit({ type: "done", ok: true });
  } catch (e) {
    flush();
    msg("system", `Session failed: ${e?.message ?? e}`);
    emit({ type: "done", ok: false, error: e?.message ?? String(e) });
  } finally {
    try { unsubscribe?.(); } catch { /* noop */ }
    try { await client.stop?.(); } catch { /* noop */ }
  }
}

function truncate(s, n) {
  if (typeof s !== "string") s = String(s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function stringifyOutput(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** If the prompt told the agent to write to CONVEYER_ARTIFACT_PATH and it
 *  did, emit the artifact event so Conveyer registers it on the phase. */
async function checkArtifactWritten() {
  const p = env.CONVEYER_ARTIFACT_PATH;
  if (!p) return;
  try {
    await fs.access(p);
    emit({ type: "artifact", path: p });
  } catch {
    // No artifact — that's fine; the phase still completes.
  }
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

  const backend = env.CONVEYER_BACKEND || "copilot";
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
