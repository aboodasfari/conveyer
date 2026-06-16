import { useState } from "react";
import { Box, Button, Spinner, Text, Textarea, Label } from "@primer/react";
import { CheckIcon, TrashIcon, ReplyIcon, ChevronDownIcon, ChevronRightIcon } from "@primer/octicons-react";
import { Comment, CommentMessage } from "../types";
import { api } from "../api";
import { formatError } from "../errors";
import { RichText } from "./RichText";

const STATUS_META: Record<string, { label: string; variant: "default" | "accent" | "success" | "attention" | "done" }> = {
  queued: { label: "Queued", variant: "default" },
  working: { label: "Working", variant: "accent" },
  addressed: { label: "Addressed", variant: "attention" },
  accepted: { label: "Accepted", variant: "done" },
};

function parseThread(comment: Comment): CommentMessage[] {
  if (comment.thread_json) {
    try {
      const arr = JSON.parse(comment.thread_json) as CommentMessage[];
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch {
      // fall through
    }
  }
  // Legacy fallback: synthesize from body + agent_reply.
  const out: CommentMessage[] = [{ role: "user", content: comment.body }];
  if (comment.agent_reply) out.push({ role: "agent", content: comment.agent_reply });
  return out;
}

/** A single review-comment thread card, anchored under its diff line. */
export function CommentCard({
  comment,
  collapsed,
  onToggleCollapsed,
}: {
  comment: Comment;
  collapsed: boolean;
  onToggleCollapsed: (next: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const meta = STATUS_META[comment.status] ?? STATUS_META.queued;
  const thread = parseThread(comment);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (
    <Label variant={meta.variant} size="small">
      {comment.status === "working" ? (
        <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          <Spinner size="small" sx={{ width: 10, height: 10 }} /> {meta.label}
        </Box>
      ) : (
        meta.label
      )}
    </Label>
  );

  // Collapsed: a single compact bar, no wasted vertical space.
  if (collapsed) {
    return (
      <Box
        onClick={() => onToggleCollapsed(false)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          border: "1px solid",
          borderColor: "border.default",
          borderRadius: 2,
          bg: "canvas.subtle",
          mx: 2,
          my: 1,
          px: 2,
          py: 1,
          cursor: "pointer",
          userSelect: "none",
          fontFamily: "normal",
          "&:hover": { bg: "canvas.inset" },
        }}
      >
        <ChevronRightIcon size={14} />
        {statusLabel}
        <Text sx={{ fontSize: 0, color: "fg.muted", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {firstLine(comment.body)}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "border.default",
        borderRadius: 2,
        bg: "canvas.overlay",
        my: 2,
        mx: 2,
        fontFamily: "normal",
      }}
    >
      <Box
        onClick={() => onToggleCollapsed(true)}
        sx={{ display: "flex", alignItems: "center", gap: 2, px: 2, py: 2, borderBottom: "1px solid", borderColor: "border.muted", cursor: "pointer", userSelect: "none" }}
      >
        <ChevronDownIcon size={14} />
        {statusLabel}
        <Box sx={{ flex: 1 }} />
        {comment.status !== "working" && (
          <Button
            size="small"
            variant="invisible"
            leadingVisual={TrashIcon}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); void act(() => api.commentDelete(comment.id)); }}
            aria-label="Delete comment"
          />
        )}
      </Box>

      {/* Thread: each message as its own bubble. */}
      <Box sx={{ display: "flex", flexDirection: "column" }}>
        {thread.map((m, i) => (
          <Box
            key={i}
            sx={{
              px: 3, py: 2,
              borderTop: i === 0 ? "none" : "1px solid",
              borderColor: "border.muted",
              bg: m.role === "agent" ? "canvas.subtle" : "transparent",
            }}
          >
            <Text sx={{ fontSize: 0, fontWeight: 600, color: "fg.muted", display: "block", mb: 1 }}>
              {m.role === "agent" ? "Agent" : "You"}
            </Text>
            {m.role === "agent" ? (
              <Box sx={{ fontSize: 1 }}><RichText content={m.content} /></Box>
            ) : (
              <Text sx={{ fontSize: 1, whiteSpace: "pre-wrap", display: "block" }}>{m.content}</Text>
            )}
          </Box>
        ))}
      </Box>

      {error && (
        <Text sx={{ color: "danger.fg", fontSize: 0, px: 3, py: 1, display: "block" }}>{error}</Text>
      )}

      {comment.status === "addressed" && !reopening && (
        <Box sx={{ display: "flex", gap: 2, px: 3, py: 2, borderTop: "1px solid", borderColor: "border.muted" }}>
          <Button
            size="small"
            variant="primary"
            leadingVisual={CheckIcon}
            disabled={busy}
            onClick={() => void act(async () => { await api.commentAccept(comment.id); onToggleCollapsed(true); })}
          >
            Accept
          </Button>
          <Button
            size="small"
            leadingVisual={ReplyIcon}
            disabled={busy}
            onClick={() => setReopening(true)}
          >
            Reopen
          </Button>
        </Box>
      )}

      {comment.status === "addressed" && reopening && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, px: 3, py: 2, borderTop: "1px solid", borderColor: "border.muted" }}>
          <Textarea
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (followUp.trim().length > 0 && !busy) {
                  void act(async () => {
                    await api.commentReopen(comment.id, followUp.trim());
                    setReopening(false);
                    setFollowUp("");
                  });
                }
              }
              if (e.key === "Escape") { setReopening(false); setFollowUp(""); }
            }}
            placeholder="What still needs changing?"
            rows={2}
            disabled={busy}
            sx={{ width: "100%" }}
          />
          <Box sx={{ display: "flex", gap: 2 }}>
            <Button
              size="small"
              variant="primary"
              disabled={busy || followUp.trim().length === 0}
              onClick={() =>
                void act(async () => {
                  await api.commentReopen(comment.id, followUp.trim());
                  setReopening(false);
                  setFollowUp("");
                })
              }
            >
              Send back
            </Button>
            <Button size="small" disabled={busy} onClick={() => { setReopening(false); setFollowUp(""); }}>
              Cancel
            </Button>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "(comment)";
}

/** Inline composer for a new comment anchored to a diff line/range. */
export function CommentComposer({
  phaseId,
  filePath,
  lineStart,
  lineEnd,
  side,
  snippet,
  onDone,
}: {
  phaseId: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  side: string | null;
  snippet: string | null;
  onDone: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.commentCreate({
        phase_id: phaseId,
        file_path: filePath,
        line_start: lineStart,
        line_end: lineEnd,
        side,
        snippet,
        body: trimmed,
      });
      setBody("");
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "border.default",
        borderRadius: 2,
        bg: "canvas.overlay",
        my: 2,
        mx: 2,
        p: 2,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        fontFamily: "normal",
      }}
    >
      <Textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") onDone();
        }}
        placeholder="Leave a comment for the agent to address."
        rows={3}
        disabled={busy}
        sx={{ width: "100%" }}
      />
      {error && <Text sx={{ color: "danger.fg", fontSize: 0 }}>{error}</Text>}
      <Box sx={{ display: "flex", gap: 2, justifyContent: "flex-end", alignItems: "center" }}>
        <Text sx={{ color: "fg.muted", fontSize: 0, mr: "auto" }}>⌘/Ctrl + Enter</Text>
        <Button size="small" disabled={busy} onClick={onDone}>Cancel</Button>
        <Button size="small" variant="primary" disabled={busy || body.trim().length === 0} onClick={() => void submit()}>
          {busy ? "Adding…" : "Comment"}
        </Button>
      </Box>
    </Box>
  );
}
