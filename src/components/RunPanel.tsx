import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Flash, IconButton, Spinner, Text } from "@primer/react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  FileIcon,
  GitPullRequestIcon,
  PlayIcon,
  ReplyIcon,
} from "@primer/octicons-react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { Phase, RunDetail } from "../types";
import { formatError } from "../errors";
import { TabStrip } from "./TabStrip";

const PHASE_LABELS: Record<string, string> = {
  exploration: "Exploration",
  planning: "Planning",
  implementation: "Implementation",
  review: "Review",
  submit: "Submit",
};

const STATE_COLORS: Record<string, string> = {
  pending: "#6e7681",
  running: "#1f6feb",
  waiting: "#d29922",
  done: "#3fb950",
  failed: "#f85149",
  skipped: "#6e7681",
};

const STATE_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "In Progress",
  waiting: "Done, Awaiting Approval",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const RUN_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Awaiting Approval",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

type ContentTab = { id: string; label: string; icon: React.ComponentType<{ size?: number }> };

const CHAT_TAB: ContentTab = {
  id: "chat",
  label: "Chat",
  icon: CommentDiscussionIcon,
};

/**
 * Each phase has its own dedicated content tab(s) plus a Chat tab where
 * the session thinking will surface in M4.
 */
const PHASE_TABS: Record<string, ContentTab[]> = {
  exploration: [{ id: "context", label: "Context", icon: FileIcon }, CHAT_TAB],
  planning: [{ id: "plan", label: "Plan", icon: FileIcon }, CHAT_TAB],
  implementation: [{ id: "diff", label: "Diff", icon: FileDiffIcon }, CHAT_TAB],
  review: [{ id: "review", label: "Review", icon: FileIcon }, CHAT_TAB],
  submit: [{ id: "pr", label: "Pull Request", icon: GitPullRequestIcon }, CHAT_TAB],
};

const PLACEHOLDERS: Record<string, string> = {
  context: "The exploration session will write a context document here, summarising what it learned about the codebase and the task.",
  plan: "The planning session will produce an implementation plan here, broken into tasks.",
  diff: "Code diffs from the implementation session(s) will show up here.",
  review: "The review session will land its findings here — must-fix issues, nits, or LGTM.",
  pr: "Once Submit creates the draft PR, the link and required check status will appear here.",
  chat: "Session chat & thinking will stream in here. You'll be able to inject prompts to steer the agent.",
};

interface RunUpdatedPayload {
  task_id: string;
  run_id: string;
}

export function RunPanel({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<string>("context");

  const reload = useCallback(async () => {
    setError(null);
    try {
      const runs = await api.runsForTask(taskId);
      if (runs.length === 0) {
        setDetail(null);
      } else {
        setDetail(await api.runGet(runs[0].id));
      }
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { void reload(); }, [reload]);

  // Default selection: the active phase, falling back to the first phase.
  useEffect(() => {
    if (!detail || selectedPhaseId) return;
    const active = detail.phases.find((p) => p.status === "running" || p.status === "waiting");
    const target = active ?? detail.phases[0];
    setSelectedPhaseId(target?.id ?? null);
    if (target) {
      const firstTab = PHASE_TABS[target.kind]?.[0]?.id;
      if (firstTab) setContentTab(firstTab);
    }
  }, [detail, selectedPhaseId]);

  // Whenever the user selects a phase whose tab set doesn't contain the
  // current tab id, snap to that phase's first tab.
  useEffect(() => {
    if (!detail || !selectedPhaseId) return;
    const phase = detail.phases.find((p) => p.id === selectedPhaseId);
    if (!phase) return;
    const tabs = PHASE_TABS[phase.kind] ?? [];
    if (!tabs.some((t) => t.id === contentTab)) {
      setContentTab(tabs[0]?.id ?? "chat");
    }
  }, [selectedPhaseId, detail, contentTab]);

  // Live updates pushed from Rust on every phase transition.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<RunUpdatedPayload>("run_updated", (e) => {
        if (e.payload.task_id === taskId) void reload();
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [taskId, reload]);

  const wrap = async (fn: () => Promise<RunDetail | null>) => {
    setBusy(true);
    setError(null);
    try {
      const d = await fn();
      if (d) setDetail(d);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () => wrap(async () => api.runsStart(taskId));
  const complete = (id: string) => wrap(async () => api.phaseComplete(id));
  const approve = (id: string) => wrap(async () => api.phaseApprove(id));
  const rewindToImplementation = () => wrap(async () => {
    if (!detail) return null;
    const impl = detail.phases.find((p) => p.kind === "implementation");
    if (!impl) return null;
    return api.phaseRewind(impl.id);
  });

  const selectedPhase = useMemo(() => {
    if (!detail || !selectedPhaseId) return null;
    return detail.phases.find((p) => p.id === selectedPhaseId) ?? null;
  }, [detail, selectedPhaseId]);

  if (loading) return <Spinner size="small" />;

  if (!detail) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {error && <Flash variant="danger">{error}</Flash>}
        <Text sx={{ color: "fg.muted" }}>
          No run yet. Tackle creates a run and starts the first phase.
        </Text>
        <Button
          leadingVisual={PlayIcon}
          variant="primary"
          onClick={start}
          disabled={busy}
          sx={{ alignSelf: "flex-start" }}
        >
          {busy ? "Starting…" : "Tackle"}
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0 }}>
      {error && <Flash variant="danger">{error}</Flash>}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: collapsed ? "40px 1fr" : "300px 1fr",
          gridTemplateRows: "1fr",
          gap: 3,
          alignItems: "stretch",
          flex: 1,
          minHeight: 0,
          transition: "grid-template-columns 200ms ease",
        }}
      >
        {collapsed ? (
          <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "center", pt: 1 }}>
            <IconButton
              aria-label="Expand phases"
              icon={ChevronRightIcon}
              variant="default"
              size="small"
              onClick={() => setCollapsed(false)}
            />
          </Box>
        ) : (
          <Sidebar
            detail={detail}
            selectedPhaseId={selectedPhaseId}
            busy={busy}
            onCollapse={() => setCollapsed(true)}
            onSelect={setSelectedPhaseId}
            onComplete={complete}
            onApprove={approve}
            onRewind={rewindToImplementation}
          />
        )}

        <Box
          sx={{
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "border.default",
            borderRadius: 2,
            bg: "canvas.default",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {selectedPhase ? (
            <PhaseContent
              phase={selectedPhase}
              tab={contentTab}
              onTabChange={setContentTab}
            />
          ) : (
            <Box sx={{ p: 4, color: "fg.muted" }}>
              <Text>Select a phase from the timeline to view its content.</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function Sidebar({
  detail,
  selectedPhaseId,
  busy,
  onCollapse,
  onSelect,
  onComplete,
  onApprove,
  onRewind,
}: {
  detail: RunDetail;
  selectedPhaseId: string | null;
  busy: boolean;
  onCollapse: () => void;
  onSelect: (id: string) => void;
  onComplete: (id: string) => void;
  onApprove: (id: string) => void;
  onRewind: () => void;
}) {
  return (
    <Box
      sx={{
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        overflow: "hidden",
        bg: "canvas.default",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1,
          borderBottomWidth: 1,
          borderBottomStyle: "solid",
          borderBottomColor: "border.muted",
          bg: "canvas.subtle",
          flexShrink: 0,
        }}
      >
        <Text sx={{ fontSize: 0, color: "fg.muted", fontWeight: 600 }}>
          Run · {RUN_STATUS_LABELS[detail.run.status] ?? detail.run.status}
        </Text>
        <IconButton
          aria-label="Collapse phases"
          icon={ChevronLeftIcon}
          variant="invisible"
          size="small"
          onClick={onCollapse}
        />
      </Box>
      <Box sx={{ flex: 1, overflowY: "auto", py: 1 }}>
        {detail.phases.map((p, i) => (
          <PhaseRow
            key={p.id}
            phase={p}
            first={i === 0}
            last={i === detail.phases.length - 1}
            selected={p.id === selectedPhaseId}
            busy={busy}
            onSelect={() => onSelect(p.id)}
            onComplete={() => onComplete(p.id)}
            onApprove={() => onApprove(p.id)}
            onRewind={onRewind}
          />
        ))}
      </Box>
    </Box>
  );
}

function PhaseRow({
  phase,
  first,
  last,
  selected,
  busy,
  onSelect,
  onComplete,
  onApprove,
  onRewind,
}: {
  phase: Phase;
  first: boolean;
  last: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onComplete: () => void;
  onApprove: () => void;
  onRewind: () => void;
}) {
  const color = STATE_COLORS[phase.status] ?? "#6e7681";
  const canRewindToImpl = phase.kind === "review" &&
    (phase.status === "running" || phase.status === "waiting");

  return (
    <Box
      onClick={onSelect}
      sx={{
        display: "flex",
        gap: 2,
        px: 2,
        cursor: "pointer",
        userSelect: "none",
        bg: selected ? "accent.subtle" : "transparent",
        borderLeftWidth: 3,
        borderLeftStyle: "solid",
        borderLeftColor: selected ? "accent.fg" : "transparent",
        transition: "background-color 80ms",
        "&:hover": { bg: selected ? "accent.subtle" : "canvas.subtle" },
      }}
    >
      {/* Timeline rail: dot with connecting lines above and below */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: 20,
          flexShrink: 0,
        }}
      >
        <Box
          sx={{
            flex: "0 0 14px",
            width: 2,
            bg: first ? "transparent" : "border.muted",
          }}
        />
        <Box
          sx={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            bg: color,
            flexShrink: 0,
            boxShadow:
              phase.status === "running"
                ? "0 0 0 4px rgba(31,111,235,0.25)"
                : "none",
          }}
        />
        <Box
          sx={{
            flex: 1,
            width: 2,
            bg: last ? "transparent" : "border.muted",
            minHeight: 8,
          }}
        />
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, py: 2, pr: 1 }}>
        <Text sx={{ fontWeight: 600, display: "block" }}>
          {PHASE_LABELS[phase.kind] ?? phase.kind}
        </Text>
        <Text sx={{ color: "fg.muted", fontSize: 0, display: "block", mb: 1 }}>
          {STATE_LABELS[phase.status] ?? phase.status}
        </Text>
        {phase.status === "running" && (
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button
              leadingVisual={CheckIcon}
              size="small"
              onClick={(e) => { e.stopPropagation(); onComplete(); }}
              disabled={busy}
            >
              Mark Complete
            </Button>
            {canRewindToImpl && (
              <Button
                leadingVisual={ReplyIcon}
                size="small"
                variant="danger"
                onClick={(e) => { e.stopPropagation(); onRewind(); }}
                disabled={busy}
                title="Send the work back to Implementation"
              >
                Send Back
              </Button>
            )}
          </Box>
        )}
        {phase.status === "waiting" && (
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button
              leadingVisual={CheckIcon}
              variant="primary"
              size="small"
              onClick={(e) => { e.stopPropagation(); onApprove(); }}
              disabled={busy}
            >
              Approve
            </Button>
            {canRewindToImpl && (
              <Button
                leadingVisual={ReplyIcon}
                size="small"
                variant="danger"
                onClick={(e) => { e.stopPropagation(); onRewind(); }}
                disabled={busy}
                title="Send the work back to Implementation"
              >
                Send Back
              </Button>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function PhaseContent({
  phase,
  tab,
  onTabChange,
}: {
  phase: Phase;
  tab: string;
  onTabChange: (t: string) => void;
}) {
  const tabs = PHASE_TABS[phase.kind] ?? [CHAT_TAB];
  const placeholder = PLACEHOLDERS[tab] ?? "";

  return (
    <>
      <Box sx={{ px: 3, pt: 3, flexShrink: 0 }}>
        <TabStrip<string> tabs={tabs} active={tab} onChange={onTabChange} />
      </Box>
      <Box sx={{ p: 4, flex: 1, overflowY: "auto", color: "fg.muted" }}>
        <Text>{placeholder}</Text>
        <Text sx={{ display: "block", mt: 3, fontSize: 0 }}>
          (Wires up in M4 when sessions ship.)
        </Text>
      </Box>
    </>
  );
}
