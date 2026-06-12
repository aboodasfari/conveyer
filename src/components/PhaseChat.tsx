import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Label, Spinner, Text } from "@primer/react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { Message, Session } from "../types";

interface MessageAppended {
  session_id: string;
  role: string;
  content: string;
}

const ROLE_COLORS: Record<string, string> = {
  user: "accent.fg",
  assistant: "fg.default",
  tool: "attention.fg",
  system: "fg.muted",
};

/**
 * Streams the messages from the most recent session attached to a phase.
 * Subscribes to `message_appended` events for real-time updates.
 */
export function PhaseChat({ phaseId }: { phaseId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

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

  // Listen for live appends. We refetch the session list when a new
  // session_id appears (e.g. on rewind), otherwise just append.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<MessageAppended>("message_appended", (e) => {
        const p = e.payload;
        // Cheap filter: only update if this session is the one we're showing.
        setMessages((prev) => {
          if (!session) {
            // Late-binding: we don't know our session yet, defer to a reload.
            void load();
            return prev;
          }
          if (p.session_id !== session.id) return prev;
          return [
            ...prev,
            {
              id: prev.length ? prev[prev.length - 1].id + 1 : 1,
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

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (loading) return <Spinner size="small" />;
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
        gap: 2,
        height: "100%",
        overflowY: "auto",
      }}
    >
      {messages.length === 0 ? (
        <Text sx={{ color: "fg.muted" }}>Session started; awaiting output.</Text>
      ) : (
        messages.map((m) => <MessageRow key={m.id} message={m} />)
      )}
    </Box>
  );
}

function MessageRow({ message }: { message: Message }) {
  const color = ROLE_COLORS[message.role] ?? "fg.default";
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
        <Label size="small" variant="default">
          {message.role}
        </Label>
        <Text sx={{ color: "fg.subtle", fontSize: 0 }}>
          {message.ts.replace("T", " ").replace("Z", "").slice(0, 19)}
        </Text>
      </Box>
      <Box
        sx={{
          color,
          fontSize: 1,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          pl: 1,
        }}
      >
        {message.content}
      </Box>
    </Box>
  );
}
