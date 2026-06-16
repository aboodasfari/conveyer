import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Spinner, Text, Textarea } from "@primer/react";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  XCircleIcon,
} from "@primer/octicons-react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { Message, PendingInput, Session } from "../types";
import { RichText } from "./RichText";
import { formatError } from "../errors";

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

interface SeparatorBubble {
  kind: "separator";
  id: string;
  label: string;
}

type Bubble = ToolBubble | ChatBubble | SeparatorBubble;

/**
 * Pair tool_call_start / tool_call_complete rows by tool_call_id and turn
 * everything into a flat array of bubbles that the renderer iterates.
 * Messages with role "system" whose content starts with "[thinking]" are
 * re-classed as thinking bubbles for styling.
 *
 * `runs` is one entry per Session row for the phase (oldest first). A
 * thin separator bubble is inserted between runs so the user can see
 * the boundary between a rejected attempt and the next one. Tool-call
 * pairing is per-run — calls don't bridge sessions.
 */
function buildBubbles(
  runs: { session: Session; messages: Message[] }[],
): Bubble[] {
  const out: Bubble[] = [];
  runs.forEach((run, idx) => {
    // Only flag the boundary between distinct phase attempts (role
    // 'main', i.e. a re-spawned runner after send-back / rewind).
    // Chat replies (role 'reply') stream as a continuation of the
    // same phase — no separator.
    if (idx > 0 && run.session.role === "main") {
      const label = `New attempt · ${formatRunStart(run.session.started_at)}`;
      out.push({ kind: "separator", id: `sep-${run.session.id}`, label });
    }
    out.push(...buildBubblesForMessages(run.messages));
  });
  return out;
}

function buildBubblesForMessages(messages: Message[]): Bubble[] {
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

function formatRunStart(iso: string | null | undefined): string {
  if (!iso) return "new session";
  const d = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return "new session";
  return d.toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

export function PhaseChat({
  phaseId,
  phaseStatus,
  runStatus,
  pendingInput,
}: {
  phaseId: string;
  phaseStatus: string;
  runStatus: string;
  pendingInput?: string | null;
}) {
  const [runs, setRuns] = useState<{ session: Session; messages: Message[] }[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const nextLocalId = useRef(-1);

  const load = useCallback(async () => {
    try {
      const sessions = await api.sessionsForPhase(phaseId);
      const loaded = await Promise.all(
        sessions.map(async (s) => ({
          session: s,
          messages: await api.messagesForSession(s.id),
        })),
      );
      setRuns(loaded);
    } finally {
      setInitialLoading(false);
    }
  }, [phaseId]);

  // Latest session id; streaming events only target this one.
  const latestSession = runs.length > 0 ? runs[runs.length - 1].session : null;

  useEffect(() => { void load(); }, [load]);

  // Re-load when the run state changes (so session.status flips
  // running -> done and the streaming pulse stops). Also reload on
  // window focus-regain — macOS throttles event delivery to hidden
  // WebViews, so the UI can be stale by the time the user returns.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen("run_updated", () => { void load(); });
      if (cancelled) unlisten();
    })();
    const onFocus = () => { void load(); };
    window.addEventListener("conveyer:focus-refresh", onFocus);
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      window.removeEventListener("conveyer:focus-refresh", onFocus);
    };
  }, [load]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<MessageAppended>("message_appended", (e) => {
        const p = e.payload;
        setRuns((prev) => {
          if (prev.length === 0) {
            void load();
            return prev;
          }
          // Append to whichever run owns the session_id. Almost always the
          // latest, but a slow event during a rewind could in theory arrive
          // for an older one — we still find it correctly.
          const idx = prev.findIndex((r) => r.session.id === p.session_id);
          if (idx === -1) {
            // Unknown session id — a brand-new session just spawned; pull
            // the full list so we pick up the new run.
            void load();
            return prev;
          }
          const target = prev[idx];
          const nextMessages = [
            ...target.messages,
            {
              id: nextLocalId.current--,
              session_id: p.session_id,
              ts: new Date().toISOString(),
              role: p.role,
              content: p.content,
            } as Message,
          ];
          const next = prev.slice();
          next[idx] = { ...target, messages: nextMessages };
          return next;
        });
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [load]);

  const bubbles = useMemo(() => buildBubbles(runs), [runs]);

  // Heartbeat the warm chat sidecar (if one exists) every 30s while
  // this chat view is mounted, so the process stays alive as long as
  // the user is looking at it. The backend command is a no-op when
  // no warm sidecar exists, so we can fire-and-forget.
  useEffect(() => {
    let cancelled = false;
    const ping = () => { if (!cancelled) void api.chatHeartbeat(phaseId); };
    ping();
    const id = window.setInterval(ping, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phaseId]);

  // Eagerly spawn the warm chat sidecar when the chat would actually
  // be usable, so the user's first message hits a hot SDK instead of
  // paying ~5s of cold-start. Skipped for failed / cancelled phases
  // (no chat allowed — Restart is the path forward) and for terminal
  // 'done' phases in the middle of a pipeline. Best-effort: backend
  // silently no-ops if there's no resumable SDK session.
  useEffect(() => {
    const canWarm =
      phaseStatus === "waiting" ||
      (phaseStatus === "done" && runStatus === "done");
    if (!canWarm) return;
    void api.chatWarm(phaseId);
  }, [phaseId, phaseStatus, runStatus]);

  // Pulse on the last bubble. For 'main' sessions the existing
  // signal (session.status === 'running') is right — process alive
  // means agent producing. For 'chat' sessions the process stays
  // alive between turns; we listen to chat_turn_state events from
  // Rust to know when a turn is actually in flight.
  const [chatTurnBusy, setChatTurnBusy] = useState(false);
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<{ phase_id: string; busy: boolean }>(
        "chat_turn_state",
        (e) => {
          if (cancelled) return;
          if (e.payload.phase_id !== phaseId) return;
          setChatTurnBusy(e.payload.busy);
        },
      );
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [phaseId]);

  // Scroll behaviour: preserve user's position across tab-switch
  // mounts; sticky-bottom auto-scroll that follows new bubbles AND
  // streaming content (assistant deltas grow an existing bubble).
  //
  // The model is one boolean ref `stickyRef` ("user wants to follow
  // the conversation"): true while scrolled to bottom, false the
  // moment they scroll up. Auto-scroll fires whenever the scroll
  // container's content height changes AND sticky is true. Position
  // is also persisted to sessionStorage so a tab-switch restores it.
  const SCROLL_KEY = `conveyer:chat-scroll:${phaseId}`;
  const stickyRef = useRef(true);
  const scrollRestoredRef = useRef(false);

  // Track scroll: update sticky + persist position.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickyRef.current = dist < 80;
      // Only persist after we've successfully restored, otherwise the
      // initial layout pass (scrollTop=0 before restore) overwrites
      // the previous saved value.
      if (scrollRestoredRef.current) {
        sessionStorage.setItem(SCROLL_KEY, String(el.scrollTop));
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [SCROLL_KEY]);

  // Restore once, after the first content render. Use rAF to wait for
  // layout, otherwise scrollHeight is still based on the empty state.
  useEffect(() => {
    if (initialLoading || scrollRestoredRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const saved = sessionStorage.getItem(SCROLL_KEY);
      if (saved !== null) {
        const n = Number(saved);
        if (Number.isFinite(n)) {
          el.scrollTop = n;
        } else {
          el.scrollTop = el.scrollHeight;
        }
      } else {
        el.scrollTop = el.scrollHeight;
      }
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickyRef.current = dist < 80;
      scrollRestoredRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [initialLoading, SCROLL_KEY]);

  // Sticky-bottom: whenever the scroll container's content grows AND
  // the user hasn't scrolled away from the bottom, follow. Uses
  // ResizeObserver so this catches both new-bubble adds AND streaming
  // content growth within an existing bubble.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!scrollRestoredRef.current) return;
      if (!stickyRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    // Observe all current and future children (one observer per child
    // catches their content size changes).
    for (const child of Array.from(el.children)) {
      ro.observe(child as Element);
    }
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) {
        ro.observe(child as Element);
      }
    });
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, []);

  // Chat-input state. Enabled / disabled per the policy in
  // computeChatMode(), which depends on the phase + run status.
  const chatMode = useMemo(
    () => computeChatMode(phaseStatus, runStatus, latestSession),
    [phaseStatus, runStatus, latestSession],
  );
  // Parse the pending ask_user request (if any) for the answer widget.
  const pending = useMemo<PendingInput | null>(() => {
    if (!pendingInput) return null;
    try {
      return JSON.parse(pendingInput) as PendingInput;
    } catch {
      return null;
    }
  }, [pendingInput]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setSendError(null);
    // Snap to bottom + re-arm sticky so the user sees their message
    // and the agent's reply land in real time.
    stickyRef.current = true;
    try {
      await api.chatReply(phaseId, content);
      setDraft("");
    } catch (e) {
      setSendError(formatError(e));
    } finally {
      setSending(false);
    }
  }, [draft, phaseId, sending]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
          pr: 3,
        }}
      >
        {initialLoading && runs.length === 0 ? (
          <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", flex: 1 }}>
            <Spinner size="small" />
          </Box>
        ) : !latestSession ? (
          <Text sx={{ color: "fg.muted" }}>
            No session yet. The Chat tab will stream the agent's thinking once
            this phase is running.
          </Text>
        ) : bubbles.length === 0 ? (
          <Text sx={{ color: "fg.muted" }}>Session started; awaiting output.</Text>
        ) : (
          bubbles.map((b, i) => {
            const isLast = i === bubbles.length - 1;
            const pulse = isLast && (
              latestSession.role === "chat"
                ? chatTurnBusy
                : latestSession.status === "running"
            );
            return (
              <BubbleView
                key={b.id}
                bubble={b}
                streaming={pulse}
              />
            );
          })
        )}
      </Box>

      {phaseStatus === "needs_input" && pending ? (
        <Box
          sx={{
            mt: 3,
            pt: 3,
            borderTopWidth: 1,
            borderTopStyle: "solid",
            borderTopColor: "attention.muted",
          }}
        >
          <NeedsInputForm
            phaseId={phaseId}
            prompt={pending.prompt}
            choices={pending.choices ?? null}
          />
        </Box>
      ) : chatMode.kind !== "hidden" ? (
        <Box
          sx={{
            mt: 3,
            pt: 3,
            borderTopWidth: 1,
            borderTopStyle: "solid",
            borderTopColor: "border.muted",
          }}
        >
          {chatMode.kind === "disabled-hint" ? (
            <Text sx={{ color: "fg.muted", fontSize: 0 }}>{chatMode.hint}</Text>
          ) : (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={chatMode.placeholder}
                rows={3}
                resize="vertical"
                disabled={sending}
                sx={{ width: "100%", fontFamily: "mono", fontSize: 1 }}
              />
              {sendError && (
                <Text sx={{ color: "danger.fg", fontSize: 0 }}>{sendError}</Text>
              )}
            </Box>
          )}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Answer widget shown when the agent has called `ask_user` and the phase
 * is paused on 'needs_input'. Multiple-choice buttons (when provided)
 * plus a free-text field that always works as an override / open answer.
 */
function NeedsInputForm({
  phaseId,
  prompt,
  choices,
}: {
  phaseId: string;
  prompt: string;
  choices: string[] | null;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        await api.phaseSubmitInput(phaseId, trimmed);
        setDraft("");
      } catch (e) {
        setError(formatError(e));
      } finally {
        setSubmitting(false);
      }
    },
    [phaseId, submitting],
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Text sx={{ fontSize: 0, fontWeight: 600, color: "attention.fg" }}>
        The agent needs your input
      </Text>
      <Box sx={{ fontSize: 1 }}>
        <RichText content={prompt} />
      </Box>
      {choices && choices.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {choices.map((c) => (
            <Button
              key={c}
              disabled={submitting}
              onClick={() => void submit(c)}
              sx={{ width: "100%", justifyContent: "flex-start", textAlign: "left" }}
            >
              {c}
            </Button>
          ))}
        </Box>
      )}
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit(draft);
          }
        }}
        placeholder={
          choices && choices.length > 0
            ? "Or type your own answer."
            : "Type your answer."
        }
        rows={2}
        resize="vertical"
        disabled={submitting}
        sx={{ width: "100%", fontFamily: "mono", fontSize: 1 }}
      />
      {error && <Text sx={{ color: "danger.fg", fontSize: 0 }}>{error}</Text>}
    </Box>
  );
}

/**
 * Decide whether the chat input is shown, and in what guise, for the
 * current phase + run state. See the design notes in the conversation
 * around 2026-06-15 — "chat is enabled wherever there's no active
 * phase blocking it".
 */
type ChatMode =
  | { kind: "hidden" }
  | { kind: "disabled-hint"; hint: string }
  | { kind: "enabled"; placeholder: string };

function computeChatMode(
  phaseStatus: string,
  runStatus: string,
  latestSession: Session | null,
): ChatMode {
  if (!latestSession || !latestSession.sdk_session_id) {
    return { kind: "hidden" };
  }
  switch (phaseStatus) {
    case "pending":
      return { kind: "hidden" };
    case "running":
      return {
        kind: "disabled-hint",
        hint: "Agent is working. You can chat once it pauses for review.",
      };
    case "waiting":
      return {
        kind: "enabled",
        placeholder:
          "Reply to the agent. Ask a question, request a change, or steer before approving.",
      };
    case "failed":
    case "cancelled":
      return {
        kind: "disabled-hint",
        hint: "This phase ended in failure. Restart it to talk to the agent again.",
      };
    case "done":
      if (runStatus === "done") {
        return {
          kind: "enabled",
          placeholder: "Continue working with the agent.",
        };
      }
      return {
        kind: "disabled-hint",
        hint: "This phase is sealed. Use Send Back on a later phase to reopen it.",
      };
    default:
      return { kind: "hidden" };
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Bubbles                                   */
/* -------------------------------------------------------------------------- */

function BubbleView({ bubble, streaming }: { bubble: Bubble; streaming: boolean }) {
  if (bubble.kind === "separator") return <SeparatorBubbleView label={bubble.label} />;
  if (bubble.kind === "tool") return <ToolBubbleView bubble={bubble} streaming={streaming} />;
  if (bubble.kind === "thinking") return <ThinkingBubble content={bubble.content} streaming={streaming} />;
  if (bubble.kind === "user") return <UserBubble content={bubble.content} />;
  if (bubble.kind === "assistant") return <AssistantBubble content={bubble.content} streaming={streaming} />;
  return <SystemBubble content={bubble.content} />;
}

function SeparatorBubbleView({ label }: { label: string }) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        my: 2,
        color: "fg.muted",
        fontSize: 0,
      }}
    >
      <Box sx={{ flex: 1, height: "1px", bg: "border.muted" }} />
      <Text sx={{ whiteSpace: "nowrap" }}>{label}</Text>
      <Box sx={{ flex: 1, height: "1px", bg: "border.muted" }} />
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Gutter markers                                  */
/* -------------------------------------------------------------------------- */

const GUTTER_WIDTH = 18;

/** Pulse animation keyframes (injected once, globally). */
const PULSE_KEYFRAMES = `
@keyframes conveyerPulse {
  0%   { opacity: 1;   transform: scale(1);   }
  50%  { opacity: 0.4; transform: scale(0.7); }
  100% { opacity: 1;   transform: scale(1);   }
}`;
if (typeof document !== "undefined" && !document.getElementById("conveyer-pulse-kf")) {
  const style = document.createElement("style");
  style.id = "conveyer-pulse-kf";
  style.textContent = PULSE_KEYFRAMES;
  document.head.appendChild(style);
}

function Gutter({
  marker,
  streaming = false,
}: {
  marker: React.ReactNode;
  streaming?: boolean;
}) {
  return (
    <Box
      aria-hidden
      sx={{
        width: GUTTER_WIDTH,
        flexShrink: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        pt: "5px",
        animation: streaming ? "conveyerPulse 1.2s ease-in-out infinite" : "none",
      }}
    >
      {marker}
    </Box>
  );
}

/** Solid filled circle. */
function FilledDot({ color = "fg.default", size = 8 }: { color?: string; size?: number }) {
  return <Box sx={{ width: size, height: size, borderRadius: "50%", bg: color }} />;
}

/** Half-filled circle (right half empty, like ◐). */
function HalfDot({ color = "fg.muted", size = 10 }: { color?: string; size?: number }) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "1.5px solid",
        borderColor: color,
        background: `linear-gradient(90deg, currentColor 50%, transparent 50%)`,
        color,
      }}
    />
  );
}

/** Hollow ring. */
function RingDot({ color = "fg.muted", size = 8 }: { color?: string; size?: number }) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "1.5px solid",
        borderColor: color,
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Bubbles                                   */
/* -------------------------------------------------------------------------- */

/** Agent: normal-weight prose, rendered as markdown. */
function AssistantBubble({ content, streaming }: { content: string; streaming: boolean }) {
  return (
    <Box sx={{ display: "flex", gap: 1 }}>
      <Gutter marker={<FilledDot color="accent.fg" size={9} />} streaming={streaming} />
      <Box sx={{ flex: 1, color: "fg.default", fontSize: 1, lineHeight: 1.55, minWidth: 0 }}>
        <RichText content={content} />
      </Box>
    </Box>
  );
}

/** User: prepended with a chevron, like a shell prompt. */
function UserBubble({ content }: { content: string }) {
  return (
    <Box sx={{ display: "flex", gap: 1 }}>
      <Gutter
        marker={
          <Box sx={{ color: "accent.fg", display: "flex" }}>
            <ChevronRightIcon size={12} />
          </Box>
        }
      />
      <Box sx={{ flex: 1, color: "fg.default", whiteSpace: "pre-wrap", minWidth: 0 }}>{content}</Box>
    </Box>
  );
}

/** System: muted italics, terse. */
function SystemBubble({ content }: { content: string }) {
  return (
    <Box sx={{ display: "flex", gap: 1 }}>
      <Gutter marker={<RingDot color="fg.muted" size={7} />} />
      <Box
        sx={{
          flex: 1,
          color: "fg.muted",
          fontStyle: "italic",
          fontSize: 1,
          whiteSpace: "pre-wrap",
          minWidth: 0,
        }}
      >
        {content}
      </Box>
    </Box>
  );
}

/** Thinking: half-filled marker, muted italics, no inline label. */
function ThinkingBubble({ content, streaming }: { content: string; streaming: boolean }) {
  return (
    <Box sx={{ display: "flex", gap: 1 }}>
      <Gutter marker={<HalfDot color="fg.muted" size={9} />} streaming={streaming} />
      <Box
        sx={{
          flex: 1,
          color: "fg.muted",
          fontStyle: "italic",
          fontSize: 1,
          whiteSpace: "pre-wrap",
          minWidth: 0,
        }}
      >
        {content}
      </Box>
    </Box>
  );
}

/** Tool call: collapsible block with header summary + expandable details. */
function ToolBubbleView({ bubble, streaming }: { bubble: ToolBubble; streaming?: boolean }) {
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
  const pulse = !bubble.done || streaming;

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
          gap: 1,
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
            width: GUTTER_WIDTH,
            flexShrink: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            pt: "5px",
            animation: pulse ? "conveyerPulse 1.2s ease-in-out infinite" : "none",
          }}
        >
          <Box
            sx={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              bg: dotColor,
            }}
          />
        </Box>
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
