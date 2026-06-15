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
 *   {"type":"tool_call","phase":"start","tool_call_id":"...","tool":"view","arguments":{...}}
 *   {"type":"tool_call","phase":"complete","tool_call_id":"...","tool":"view","success":true,"result":"...","error":null}
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
 *   CONVEYER_COPILOT_REASONING  optional reasoning effort ("minimal" | "low" | "medium" | "high")
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
    BRANCH: env.CONVEYER_BRANCH || "",
    WORKTREE_PATH: env.CONVEYER_WORKTREE_PATH || "",
    WORKSPACES_HINT: renderWorkspacesHint(),
    CONTEXT_DOCUMENT: await readFileOr(env.CONVEYER_CONTEXT_DOC, "(no context document)"),
    PLAN_DOCUMENT: await readFileOr(env.CONVEYER_PLAN_DOC, "(no plan document)"),
    DIFF: "(diff capture wires up alongside the implementation phase)",
  };

  return renderTemplate(system, vars) + "\n\n---\n\n" + renderTemplate(phaseTpl, vars);
}

/**
 * Build the "Workspaces" section for the system prompt. Two modes:
 *
 *   - Explicit: task has a workspace pinned (CONVEYER_WORKSPACE_EXPLICIT=1).
 *     We tell the agent exactly which path to work in.
 *
 *   - Discovery: task has no workspace pinned. We list all configured
 *     workspaces (name + path) and instruct the agent to pick the most
 *     appropriate one for the task at hand.
 */
function renderWorkspacesHint() {
  const cb = env.CONVEYER_CODEBASE_PATH || "";
  const explicit = env.CONVEYER_WORKSPACE_EXPLICIT === "1";
  const raw = env.CONVEYER_WORKSPACES || "";
  const list = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, ...rest] = l.split("\t");
      return { name: (name || "").trim(), path: rest.join("\t").trim() };
    })
    .filter((w) => w.name && w.path);

  if (explicit && cb) {
    return `You are working in **${cb}**. All file reads, edits, and shell commands must operate on this workspace.`;
  }
  if (list.length === 0) {
    return cb
      ? `You are working in **${cb}**.`
      : "No workspaces are configured. Ask the user to set one in Settings.";
  }
  const bullets = list.map((w) => `- **${w.name}** — \`${w.path}\``).join("\n");
  return `No workspace is pinned for this task yet. Available workspaces:

${bullets}

**Pick the one that best matches this task** and call the \`pick_workspace\` tool with its absolute path. That pins the workspace on the task so the planning, implementation, review, and submit phases all run in the right place. If none of the listed paths fits, you may pass an absolute freeform path.

Your starting directory is \`${cb}\` (the first workspace) — feel free to \`cd\` or read files from any of the paths above before calling \`pick_workspace\`.`;
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
 * Tools registered with every Copilot session (both fresh and resumed).
 * Kept as a function so the closure can call `emit` and `msg` for the
 * out-of-band events Conveyer relies on (pick_workspace, send_back).
 */
function phaseTools() {
  return [
    {
      name: "pick_workspace",
      description:
        "Pin the absolute workspace path this task should run in for the rest of the run. " +
        "Call this once during exploration if the task does not already have a workspace pinned. " +
        "Pass an absolute filesystem path (e.g. /Users/abdul/code/rp). Conveyer will save the " +
        "pin to the task so all subsequent phases (planning, implementation, review, submit) " +
        "operate in this workspace and create the worktree from it.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the workspace directory.",
          },
        },
        required: ["path"],
      },
      skipPermission: true,
      handler: async (args) => {
        const p = String(args?.path ?? "").trim();
        if (!p) return { ok: false, error: "path is required" };
        emit({ type: "pick_workspace", path: p });
        return { ok: true, pinned: p };
      },
    },
    {
      name: "send_back_to_implementation",
      description:
        "Call this during the REVIEW phase when you have found issues that require " +
        "the implementation phase to redo work. Conveyer will then either rewind to " +
        "implementation automatically or pause for the user's approval, depending on " +
        "the user's 'auto-rewind on review send-back' gate setting. " +
        "Pass a one-line `reason` summarising what needs to change. " +
        "If your review is approving the work as-is, do NOT call this tool — simply " +
        "complete the phase normally.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Short summary (one line) of what needs to change.",
          },
        },
        required: ["reason"],
      },
      skipPermission: true,
      handler: async (args) => {
        const reason = String(args?.reason ?? "").trim();
        emit({ type: "send_back", reason });
        return { ok: true, queued: true };
      },
    },
  ];
}

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
  await runCopilotSession({ phase, prompt, resume: null });
}

/**
 * Resume an existing SDK session and feed it a fresh user message.
 * Used by the chat-reply flow when the user types into a waiting (or
 * failed / post-run) phase. The agent picks up its prior state —
 * tools registered, prompt context, prior messages — and just answers
 * the follow-up.
 *
 * The `sessionId` must be one the SDK still has on disk (see SDK
 * `getSessionMetadata` / data retention). If resume fails we surface
 * the error and exit with `ok:false`; the caller (runner) will mark
 * the phase failed.
 */
async function runCopilotReply(phase, userMessage, sessionId) {
  await runCopilotSession({
    phase,
    prompt: userMessage,
    resume: sessionId,
  });
}

/**
 * Long-lived chat REPL. Boots the SDK + resumeSession once, then
 * loops on stdin reading NDJSON commands like {"type":"reply", "content":"..."}
 * and runs sendAndWait for each. Emits {"type":"ready"} once the
 * session is resumed, {"type":"turn_done", "ok":bool} after each turn.
 * Exits cleanly on stdin EOF, an idle timeout, or a {"type":"shutdown"}
 * command. Lets the Rust runner keep a warm process per phase so
 * subsequent replies skip the SDK boot cost.
 */
async function runCopilotChatRepl(sessionId, idleMs) {
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
    const baseConfig = {
      model: env.CONVEYER_COPILOT_MODEL || "gpt-5.1",
      streaming: true,
      workingDirectory: env.CONVEYER_CODEBASE_PATH || process.cwd(),
      onPermissionRequest: approveAll ?? (() => ({ decision: "approve_once" })),
      enableSkills: true,
      pluginDirectories: await discoverPluginDirs(),
      tools: phaseTools(),
    };
    if (env.CONVEYER_COPILOT_REASONING) {
      baseConfig.reasoningEffort = env.CONVEYER_COPILOT_REASONING;
    }
    session = await client.resumeSession(sessionId, baseConfig);
    msg("system", `[chat] resumed SDK session ${sessionId.slice(0, 8)}…`);
  } catch (e) {
    msg("system", `Failed to start Copilot SDK: ${e?.message ?? e}`);
    try { await client.stop?.(); } catch { /* noop */ }
    emit({ type: "done", ok: false, error: e?.message ?? String(e) });
    return;
  }

  // Shared streaming buffer + event subscription, identical to the
  // one-shot path; we just don't tear it down between turns.
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
        emit({
          type: "tool_call",
          phase: "start",
          tool_call_id: event.data?.toolCallId ?? null,
          tool: event.data?.toolName ?? event.data?.mcpToolName ?? "tool",
          arguments: event.data?.arguments ?? null,
        });
        break;
      case "tool.execution_complete":
        emit({
          type: "tool_call",
          phase: "complete",
          tool_call_id: event.data?.toolCallId ?? null,
          tool: event.data?.toolName ?? event.data?.mcpToolName ?? "tool",
          success: event.data?.success ?? false,
          result: event.data?.result?.detailedContent ?? event.data?.result?.content ?? null,
          error: event.data?.error?.message ?? null,
        });
        break;
      case "session.error":
        msg("system", `[error] ${event.data?.message ?? JSON.stringify(event.data)}`);
        break;
      default:
        break;
    }
  });

  // Ready for commands.
  emit({ type: "ready" });

  // Read stdin line-by-line. Node's readline is the simplest way.
  const { default: readline } = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  const TURN_TIMEOUT_MS = 30 * 60 * 1000;
  let busy = false;

  // Idle watchdog. Reset before/after each turn; if it fires the
  // process exits cleanly and the next user reply will spawn a fresh
  // one. While `busy` is true we never arm the timer — sendAndWait
  // can take minutes and we don't want a ping or stale schedule to
  // kill the process mid-turn. `resetIdle()` is called both on ping
  // and on turn completion; both safely no-op while busy.
  let idleTimer = setTimeout(shutdownIdle, idleMs);
  function shutdownIdle() {
    msg("system", `[chat] idle for ${(idleMs / 1000) | 0}s, shutting down warm sidecar.`);
    emit({ type: "done", ok: true });
    setTimeout(() => process.exit(0), 50);
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    if (busy) return;
    idleTimer = setTimeout(shutdownIdle, idleMs);
  }

  for await (const line of rl) {
    if (!line.trim()) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    if (cmd.type === "shutdown") break;
    if (cmd.type === "ping") {
      // Heartbeat from the UI saying the chat tab is still mounted.
      // Pings keep the warm sidecar alive; absence of pings + replies
      // for `idleMs` causes shutdown.
      resetIdle();
      continue;
    }
    if (cmd.type !== "reply") continue;
    if (busy) {
      emit({ type: "turn_done", ok: false, error: "Previous reply still running." });
      continue;
    }
    const content = String(cmd.content ?? "").trim();
    if (!content) {
      emit({ type: "turn_done", ok: false, error: "empty reply" });
      continue;
    }
    busy = true;
    clearTimeout(idleTimer);
    try {
      await session.sendAndWait({ prompt: content }, TURN_TIMEOUT_MS);
      flush();
      emit({ type: "turn_done", ok: true });
    } catch (e) {
      flush();
      msg("system", `Session failed: ${e?.message ?? e}`);
      emit({ type: "turn_done", ok: false, error: e?.message ?? String(e) });
    } finally {
      busy = false;
      resetIdle();
    }
  }

  // EOF or shutdown command — clean up.
  clearTimeout(idleTimer);
  try { unsubscribe?.(); } catch { /* noop */ }
  try { await client.stop?.(); } catch { /* noop */ }
  emit({ type: "done", ok: true });
}

async function runCopilotSession({ phase, prompt, resume }) {
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
    const baseConfig = {
      model: env.CONVEYER_COPILOT_MODEL || "gpt-5.1",
      streaming: true,
      workingDirectory: env.CONVEYER_CODEBASE_PATH || process.cwd(),
      onPermissionRequest: approveAll ?? (() => ({ decision: "approve_once" })),
      enableSkills: true,
      pluginDirectories: await discoverPluginDirs(),
      tools: phaseTools(),
    };
    if (env.CONVEYER_COPILOT_REASONING) {
      baseConfig.reasoningEffort = env.CONVEYER_COPILOT_REASONING;
    }
    if (resume) {
      session = await client.resumeSession(resume, baseConfig);
      msg("system", `[chat] resumed SDK session ${resume.slice(0, 8)}…`);
    } else {
      session = await client.createSession(baseConfig);
      if (session?.sessionId) {
        emit({ type: "session_started", sdk_session_id: session.sessionId });
      }
    }
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
        emit({
          type: "tool_call",
          phase: "start",
          tool_call_id: event.data?.toolCallId ?? null,
          tool: event.data?.toolName ?? event.data?.mcpToolName ?? "tool",
          arguments: event.data?.arguments ?? null,
        });
        break;
      case "tool.execution_complete":
        emit({
          type: "tool_call",
          phase: "complete",
          tool_call_id: event.data?.toolCallId ?? null,
          tool: event.data?.toolName ?? event.data?.mcpToolName ?? "tool",
          success: event.data?.success ?? false,
          result: event.data?.result?.detailedContent ?? event.data?.result?.content ?? null,
          error: event.data?.error?.message ?? null,
        });
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
    // The SDK's sendAndWait defaults to a 60s timeout waiting for
    // session.idle, which is far too short for a real phase that does
    // multiple file reads, shells, and edits. Give it 30 minutes.
    const PHASE_TIMEOUT_MS = 30 * 60 * 1000;
    await session.sendAndWait({ prompt }, PHASE_TIMEOUT_MS);
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

/**
 * Discover Copilot plugin directories so the SDK loads the same skills
 * the user gets in the interactive CLI (e.g. superpowers).
 *
 * Plugins are installed under `~/.copilot/installed-plugins/<source>/<name>/`.
 * We also honour CONVEYER_PLUGIN_DIRS (colon-separated) for overrides.
 */
async function discoverPluginDirs() {
  const dirs = [];
  if (env.CONVEYER_PLUGIN_DIRS) {
    for (const p of env.CONVEYER_PLUGIN_DIRS.split(":").map((s) => s.trim()).filter(Boolean)) {
      dirs.push(p);
    }
  }
  const root = path.join(os.homedir(), ".copilot", "installed-plugins");
  try {
    const sources = await fs.readdir(root, { withFileTypes: true });
    for (const s of sources) {
      if (!s.isDirectory()) continue;
      const sourcePath = path.join(root, s.name);
      const plugins = await fs.readdir(sourcePath, { withFileTypes: true });
      for (const p of plugins) {
        if (p.isDirectory()) dirs.push(path.join(sourcePath, p.name));
      }
    }
  } catch {
    // No plugins directory — fine, just return whatever was in the env.
  }
  return dirs;
}

async function writeArtifact(body) {
  const p = env.CONVEYER_ARTIFACT_PATH;
  if (!p) return;
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf8");
  emit({ type: "artifact", path: p });
}

async function main() {
  // Special mode: list available Copilot models and exit. Used by the
  // Settings UI to populate model dropdowns.
  if (env.CONVEYER_MODE === "list_models") {
    await listModels();
    return;
  }

  // Special mode: render the prompt to {artifact_dir}/prompt.md and exit.
  // The Rust runner kicks this off before the real phase run so the Prompt
  // tab is populated even if the main run hangs/fails.
  if (env.CONVEYER_MODE === "render_prompt") {
    const phase = env.CONVEYER_PHASE;
    if (!phase) process.exit(1);
    try {
      const prompt = await buildPrompt(phase);
      if (env.CONVEYER_ARTIFACT_PATH) {
        const promptFile = path.join(path.dirname(env.CONVEYER_ARTIFACT_PATH), "prompt.md");
        await fs.mkdir(path.dirname(promptFile), { recursive: true });
        await fs.writeFile(promptFile, prompt, "utf8");
      }
      process.exit(0);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`render_prompt failed: ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  // Special mode: long-lived chat REPL. Resumes the SDK session once
  // and then loops on stdin for {"type":"reply",...} commands. Used
  // by the Rust runner to keep a warm sidecar per phase so subsequent
  // chat replies skip the SDK boot cost. Idle timeout (default 5min)
  // kills the process so we don't hold resources indefinitely.
  if (env.CONVEYER_MODE === "chat_repl") {
    const sessionId = env.CONVEYER_RESUME_SDK_SESSION;
    if (!sessionId) {
      emit({ type: "done", ok: false, error: "CONVEYER_RESUME_SDK_SESSION not set" });
      process.exit(1);
    }
    const idleMs = parseInt(env.CONVEYER_CHAT_IDLE_MS || "", 10);
    const idle = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : 5 * 60 * 1000;
    try {
      await runCopilotChatRepl(sessionId, idle);
    } catch (e) {
      emit({ type: "done", ok: false, error: e?.message ?? String(e) });
      process.exit(1);
    }
    return;
  }

  // Special mode: reply to an existing SDK session with a fresh user
  // message. The runner kicks this off when the user types into the
  // chat box of a waiting / failed / post-run phase. Uses the SDK's
  // resume API so the agent remembers everything it just did.
  if (env.CONVEYER_MODE === "reply") {
    const phase = env.CONVEYER_PHASE || "implementation";
    const sessionId = env.CONVEYER_RESUME_SDK_SESSION;
    const userMessage = env.CONVEYER_USER_MESSAGE || "";
    if (!sessionId) {
      emit({ type: "done", ok: false, error: "CONVEYER_RESUME_SDK_SESSION not set" });
      process.exit(1);
    }
    if (!userMessage.trim()) {
      emit({ type: "done", ok: false, error: "CONVEYER_USER_MESSAGE empty" });
      process.exit(1);
    }
    try {
      await runCopilotReply(phase, userMessage, sessionId);
    } catch (e) {
      emit({ type: "done", ok: false, error: e?.message ?? String(e) });
      process.exit(1);
    }
    return;
  }

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

  // Persist the rendered prompt next to the phase artifact so the UI's
  // "Prompt" tab can display exactly what the agent saw.
  if (env.CONVEYER_ARTIFACT_PATH) {
    const promptFile = path.join(path.dirname(env.CONVEYER_ARTIFACT_PATH), "prompt.md");
    try {
      await fs.mkdir(path.dirname(promptFile), { recursive: true });
      await fs.writeFile(promptFile, prompt, "utf8");
      msg("system", `[prompt] wrote to ${promptFile}`);
    } catch (e) {
      msg("system", `[prompt] write failed for ${promptFile}: ${e?.message ?? e}`);
    }
  } else {
    msg("system", "[prompt] CONVEYER_ARTIFACT_PATH not set — prompt not saved");
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

/* -------------------------------------------------------------------------- */
/*                              List models mode                              */
/* -------------------------------------------------------------------------- */

async function listModels() {
  let CopilotClient;
  try {
    ({ CopilotClient } = await import("@github/copilot-sdk"));
  } catch (e) {
    emit({ type: "models", models: [], error: `Could not load Copilot SDK: ${e?.message ?? e}` });
    return;
  }
  const client = new CopilotClient();
  try {
    await client.start?.();
    const models = await client.listModels();
    const slim = models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      // Pass through reasoning info so the UI can show a second picker.
      supported_reasoning_efforts: m.supportedReasoningEfforts ?? null,
      default_reasoning_effort: m.defaultReasoningEffort ?? null,
    }));
    emit({ type: "models", models: slim });
  } catch (e) {
    emit({ type: "models", models: [], error: e?.message ?? String(e) });
  } finally {
    try { await client.stop?.(); } catch { /* noop */ }
  }
}
