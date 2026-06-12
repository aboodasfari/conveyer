import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Spinner, Text } from "@primer/react";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  XCircleIcon,
} from "@primer/octicons-react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { Message, Session } from "../types";
import { RichText } from "./RichText";

interface MessageAppended {
  session_id: string;
  role: string;
  content: string;
}

interface ToolCallPayload {
  tool_call_id: string | null;
  tool: string;
  arguments?: unknown;
  success?: boolean | null;
  result?: string | null;
  error?: string | null;
}

interface ToolBubble {
  kind: "tool";
  id: string;
  call_id: string | null;
  tool: string;
  arguments?: unknown;
  // Filled in by the matching tool_call_complete row.
  done?: boolean;
  success?: boolean;
  result?: string | null;
  error?: string | null;
}

interface ChatBubble {
  kind: "system" | "assistant" | "user" | "thinking";
  id: string;
  content: string;
}

type Bubble = ToolBubble | ChatBubble;

/**
 * Pair tool_call_start / tool_call_complete rows by tool_call_id and turn
 * everything into a flat array of bubbles that the renderer iterates.
 * Messages with role "system" whose content starts with "[thinking]" are
 * re-classed as thinking bubbles for styling.
 */
function buildBubbles(messages: Message[]): Bubble[] {
  const out: Bubble[] = [];
  const byCallId = new Map<string, ToolBubble>();

  for (const m of messages) {
    if (m.role === "tool_call_start" || m.role === "tool_call_complete") {
      let payload: ToolCallPayload;
      try { payload = JSON.parse(m.content); } catch { continue; }
      const cid = payload.tool_call_id ?? `idx-${m.id}`;
      if (m.role === "tool_call_start") {
        const bubble: ToolBubble = {
          kind: "tool",
          id: `t-${m.id}`,
          call_id: payload.tool_call_id,
          tool: payload.tool,
          arguments: payload.arguments,
        };
        out.push(bubble);
        byCallId.set(cid, bubble);
      } else {
        const existing = byCallId.get(cid);
        if (existing) {
          existing.done = true;
          existing.success = payload.success ?? false;
          existing.result = payload.result ?? null;
          existing.error = payload.error ?? null;
        } else {
          // Orphan complete — render on its own.
          out.push({
            kind: "tool",
            id: `t-${m.id}`,
            call_id: payload.tool_call_id,
            tool: payload.tool,
            done: true,
            success: payload.success ?? false,
            result: payload.result ?? null,
            error: payload.error ?? null,
          });
        }
      }
      continue;
    }

    if (m.role === "system" && m.content.startsWith("[thinking]")) {
      out.push({
        kind: "thinking",
        id: `m-${m.id}`,
        content: m.content.replace(/^\[thinking\]\s*/, ""),
      });
      continue;
    }

    out.push({
      kind: (m.role === "assistant" || m.role === "user" ? m.role : "system"),
      id: `m-${m.id}`,
      content: m.content,
    });
  }
  return out;
}

export function PhaseChat({ phaseId }: { phaseId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const nextLocalId = useRef(-1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sessions = await api.sessionsForPhase(phaseId);
      const latest = sessions[sessions.length - 1] ?? null;
      setSession(latest);
      if (latest) {
        setMessages(await api.messagesForSession(latest.id));
      } else {
        setMessages([]);
      }
    } finally {
      setLoading(false);
    }
  }, [phaseId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<MessageAppended>("message_appended", (e) => {
        const p = e.payload;
        setMessages((prev) => {
          if (!session) {
            void load();
            return prev;
          }
          if (p.session_id !== session.id) return prev;
          return [
            ...prev,
            {
              // Negative ids stay outside any backend id range; collisions
              // resolve on the next full reload.
              id: nextLocalId.current--,
              session_id: p.session_id,
              ts: new Date().toISOString(),
              role: p.role,
              content: p.content,
            } as Message,
          ];
        });
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [session, load]);

  const bubbles = useMemo(() => buildBubbles(messages), [messages]);

  // Auto-scroll on new bubbles.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [bubbles.length]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", flex: 1 }}>
        <Spinner size="small" />
      </Box>
    );
  }
  if (!session) {
    return (
      <Text sx={{ color: "fg.muted" }}>
        No session yet. The Chat tab will stream the agent's thinking once a
        phase is running.
      </Text>
    );
  }

  return (
    <Box
      ref={scrollerRef}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        fontFamily: "mono",
        fontSize: 1,
        lineHeight: 1.45,
      }}
    >
      {bubbles.length === 0 ? (
        <Text sx={{ color: "fg.muted" }}>Session started; awaiting output.</Text>
      ) : (
        bubbles.map((b) => <BubbleView key={b.id} bubble={b} />)
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Bubbles                                   */
/* -------------------------------------------------------------------------- */

function BubbleView({ bubble }: { bubble: Bubble }) {
  if (bubble.kind === "tool") return <ToolBubbleView bubble={bubble} />;
  if (bubble.kind === "thinking") return <ThinkingBubble content={bubble.content} />;
  if (bubble.kind === "user") return <UserBubble content={bubble.content} />;
  if (bubble.kind === "assistant") return <AssistantBubble content={bubble.content} />;
  return <SystemBubble content={bubble.content} />;
}

/** Agent: normal-weight prose, rendered as markdown. */
function AssistantBubble({ content }: { content: string }) {
  return (
    <Box sx={{ pl: 3, color: "fg.default", fontSize: 1, lineHeight: 1.55 }}>
      <RichText content={content} />
    </Box>
  );
}

/** User: prepended with a chevron, like a shell prompt. */
function UserBubble({ content }: { content: string }) {
  return (
    <Box sx={{ display: "flex", gap: 2, pl: 1, color: "accent.fg" }}>
      <Text sx={{ flexShrink: 0 }}>›</Text>
      <Box sx={{ flex: 1, color: "fg.default", whiteSpace: "pre-wrap" }}>{content}</Box>
    </Box>
  );
}

/** System: muted italics, terse. */
function SystemBubble({ content }: { content: string }) {
  return (
    <Box
      sx={{
        pl: 3,
        color: "fg.muted",
        fontStyle: "italic",
        fontSize: 0,
        whiteSpace: "pre-wrap",
      }}
    >
      {content}
    </Box>
  );
}

/** Thinking: same muted italics, but slightly different colour for the eye. */
function ThinkingBubble({ content }: { content: string }) {
  return (
    <Box sx={{ pl: 3, color: "fg.muted", fontStyle: "italic", fontSize: 0 }}>
      <Text sx={{ mr: 1 }}>thinking ·</Text>
      <Text>{content}</Text>
    </Box>
  );
}

/** Tool call: collapsible block with header summary + expandable details. */
function ToolBubbleView({ bubble }: { bubble: ToolBubble }) {
  const [open, setOpen] = useState(false);

  const summary = describeTool(bubble);
  const dotColor = !bubble.done
    ? "#d29922"          // running (yellow)
    : bubble.success
      ? "#3fb950"        // done OK
      : "#f85149";       // failed
  const hasDetails = !!(
    formatArguments(bubble.arguments) ||
    bubble.result ||
    bubble.error
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Box
        as="button"
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        disabled={!hasDetails}
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 2,
          textAlign: "left",
          background: "transparent",
          border: "none",
          p: 0,
          fontFamily: "mono",
          fontSize: 1,
          color: "fg.default",
          cursor: hasDetails ? "pointer" : "default",
          width: "100%",
        }}
      >
        <Box
          aria-hidden
          sx={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            bg: dotColor,
            mt: "6px",
            flexShrink: 0,
            boxShadow: !bubble.done ? "0 0 0 3px rgba(210,153,34,0.2)" : "none",
          }}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "baseline", gap: 2 }}>
            <Text sx={{ fontWeight: 600 }}>{summary.title}</Text>
            <Text sx={{ color: "fg.muted", fontSize: 0 }}>({bubble.tool})</Text>
            {hasDetails && (
              <Box sx={{ ml: "auto", color: "fg.muted" }} aria-hidden>
                {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
              </Box>
            )}
          </Box>
          {summary.subline && (
            <Text sx={{ display: "block", color: "fg.muted", fontSize: 0, mt: "2px" }}>
              {summary.subline}
            </Text>
          )}
          {bubble.done && bubble.error && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "danger.fg", fontSize: 0, mt: "2px" }}>
              <XCircleIcon size={12} />
              <Text sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {bubble.error}
              </Text>
            </Box>
          )}
          {bubble.done && bubble.success && bubble.result && !open && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "fg.muted", fontSize: 0, mt: "2px" }}>
              <CheckCircleIcon size={12} />
              <Text sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {resultSummary(bubble.result)}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
      {open && hasDetails && (
        <Box
          sx={{
            ml: "18px",
            pl: 3,
            borderLeftWidth: 2,
            borderLeftStyle: "solid",
            borderLeftColor: "border.muted",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontSize: 0,
          }}
        >
          {formatArguments(bubble.arguments) && (
            <CodeBlock label="arguments" content={formatArguments(bubble.arguments)!} />
          )}
          {bubble.result && (
            <ResultBlock content={bubble.result} />
          )}
          {bubble.error && (
            <CodeBlock label="error" content={bubble.error} tone="danger" />
          )}
        </Box>
      )}
    </Box>
  );
}

function CodeBlock({ label, content, tone }: { label: string; content: string; tone?: "danger" }) {
  return (
    <Box>
      <Text sx={{ color: "fg.muted", display: "block", mb: 1 }}>{label}</Text>
      <Box
        as="pre"
        sx={{
          m: 0,
          p: 2,
          bg: tone === "danger" ? "danger.subtle" : "canvas.subtle",
          color: tone === "danger" ? "danger.fg" : "fg.default",
          borderRadius: 1,
          overflowX: "auto",
          whiteSpace: "pre",
          maxHeight: 320,
          fontFamily: "mono",
          fontSize: 0,
        }}
      >
        {content}
      </Box>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Smart result rendering                          */
/* -------------------------------------------------------------------------- */

/**
 * The Copilot SDK returns tool results as unified diffs even for plain reads
 * (every line is a context line). We strip that for reads and colour the
 * +/- lines for real edits.
 */
function parseDiff(s: string): { isDiff: boolean; isNoop: boolean; body: string[] } {
  if (!s || (!s.startsWith("diff --git ") && !/\n@@ /.test(s) && !s.startsWith("@@ "))) {
    return { isDiff: false, isNoop: false, body: [] };
  }
  const lines = s.split("\n");
  const body: string[] = [];
  let inHunk = false;
  let hasChange = false;
  for (const line of lines) {
    if (line.startsWith("@@ ")) { inHunk = true; continue; }
    if (!inHunk) continue;                              // skip headers
    if (line.startsWith("diff --git ")) { inHunk = false; continue; }
    if (line.startsWith("+") || line.startsWith("-")) hasChange = true;
    body.push(line);
  }
  return { isDiff: true, isNoop: !hasChange, body };
}

function ResultBlock({ content }: { content: string }) {
  const parsed = parseDiff(content);

  // Reads (no-op diffs): strip the leading space and render as plain code.
  if (parsed.isDiff && parsed.isNoop) {
    const plain = parsed.body.map((l) => (l.startsWith(" ") ? l.slice(1) : l)).join("\n");
    return <CodeBlock label="content" content={plain} />;
  }

  // Real diffs: colour +/- lines.
  if (parsed.isDiff) {
    return (
      <Box>
        <Text sx={{ color: "fg.muted", display: "block", mb: 1 }}>diff</Text>
        <Box
          as="pre"
          sx={{
            m: 0, p: 2,
            bg: "canvas.subtle",
            borderRadius: 1,
            overflowX: "auto",
            whiteSpace: "pre",
            maxHeight: 320,
            fontFamily: "mono",
            fontSize: 0,
            lineHeight: 1.5,
          }}
        >
          {parsed.body.map((line, i) => {
            const isAdd = line.startsWith("+");
            const isDel = line.startsWith("-");
            return (
              <Box
                key={i}
                sx={{
                  display: "block",
                  bg: isAdd ? "success.subtle" : isDel ? "danger.subtle" : "transparent",
                  color: isAdd ? "success.fg" : isDel ? "danger.fg" : "fg.default",
                  px: 1,
                  mx: -2,
                }}
              >
                {line || " "}
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  return <CodeBlock label="result" content={content} />;
}

/** One-line summary of a tool result for the collapsed bubble row. */
function resultSummary(s: string): string {
  const parsed = parseDiff(s);
  if (parsed.isDiff && parsed.isNoop) {
    const nonEmpty = parsed.body.filter((l) => l.trim().length > 0).length;
    return `${nonEmpty} line${nonEmpty === 1 ? "" : "s"}`;
  }
  if (parsed.isDiff) {
    let add = 0, del = 0;
    for (const l of parsed.body) {
      if (l.startsWith("+")) add++;
      else if (l.startsWith("-")) del++;
    }
    return `+${add} -${del}`;
  }
  return firstLine(s);
}

/* -------------------------------------------------------------------------- */
/*                              Tool summaries                                */
/* -------------------------------------------------------------------------- */

interface ToolSummary {
  title: string;
  subline?: string;
}

/**
 * Best-effort one-line summary for a tool call. We special-case the tools
 * the agent uses most often so the timeline reads like the Copilot CLI's.
 * Falls back to a stringified first argument for unknowns.
 */
function describeTool(b: ToolBubble): ToolSummary {
  const a = (b.arguments ?? {}) as Record<string, unknown>;
  const tool = b.tool;

  if (tool === "view" || tool === "read" || tool === "read_file") {
    const path = (a.path ?? a.file ?? a.filename) as string | undefined;
    return { title: path ? `Read ${path}` : "Read a file" };
  }
  if (tool === "grep" || tool === "search") {
    const q = (a.pattern ?? a.query ?? a.text) as string | undefined;
    const path = (a.path ?? a.dir) as string | undefined;
    return { title: `Search for ${trim(q ?? "")}`, subline: path };
  }
  if (tool === "find" || tool === "glob") {
    const pattern = (a.pattern ?? a.glob) as string | undefined;
    return { title: `Find ${trim(pattern ?? "")}` };
  }
  if (tool === "bash" || tool === "shell" || tool === "terminal") {
    const cmd = (a.command ?? a.cmd ?? a.script) as string | undefined;
    return { title: "Shell", subline: cmd ? trim(cmd, 200) : undefined };
  }
  if (tool === "create" || tool === "write" || tool === "write_file") {
    const path = (a.path ?? a.file ?? a.filename) as string | undefined;
    return { title: path ? `Create ${path}` : "Write a file" };
  }
  if (tool === "edit" || tool === "str_replace" || tool === "str_replace_editor") {
    const path = (a.path ?? a.file) as string | undefined;
    return { title: path ? `Edit ${path}` : "Edit a file" };
  }
  if (tool === "report_intent" || tool === "intent" || tool === "set_intent") {
    const intent = (a.intent ?? a.message ?? a.summary) as string | undefined;
    return { title: "Plans next step", subline: intent ? trim(intent, 200) : undefined };
  }
  if (tool === "skill" || tool === "use_skill") {
    const name = (a.skill ?? a.name) as string | undefined;
    return { title: name ? `Use skill: ${name}` : "Use a skill" };
  }

  // Generic fallback.
  const firstArg = Object.entries(a)[0];
  return {
    title: prettyToolName(tool),
    subline: firstArg ? `${firstArg[0]}: ${trim(String(firstArg[1]), 160)}` : undefined,
  };
}

function prettyToolName(t: string): string {
  // Convert snake_case / camelCase into "Title Case" words.
  return t
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatArguments(a: unknown): string | null {
  if (a === undefined || a === null) return null;
  if (typeof a === "string") return a;
  try {
    const s = JSON.stringify(a, null, 2);
    return s === "{}" ? null : s;
  } catch {
    return null;
  }
}

function trim(s: string, n = 80): string {
  s = (s ?? "").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  const line = i === -1 ? s : s.slice(0, i);
  return trim(line, 120);
}
