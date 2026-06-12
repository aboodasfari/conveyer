import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Flash, IconButton, Spinner, Text } from "@primer/react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  FileIcon,
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
  pending: "pending",
  running: "in progress",
  waiting: "done, awaiting approval",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

interface RunUpdatedPayload {
  task_id: string;
  run_id: string;
}

type ContentTab = "document" | "diff" | "chat";

export function RunPanel({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<ContentTab>("document");

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

  // When the run loads, default the selection to the active phase if any.
  useEffect(() => {
    if (!detail || selectedPhaseId) return;
    const active = detail.phases.find((p) => p.status === "running" || p.status === "waiting");
    setSelectedPhaseId(active?.id ?? detail.phases[0]?.id ?? null);
  }, [detail, selectedPhaseId]);

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
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {error && <Flash variant="danger">{error}</Flash>}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: collapsed ? "40px 1fr" : "280px 1fr",
          gap: 3,
          alignItems: "start",
          transition: "grid-template-columns 120ms",
        }}
      >
        {/* Sidebar */}
        <Box
          sx={{
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "border.default",
            borderRadius: 2,
            overflow: "hidden",
            bg: "canvas.default",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: collapsed ? "center" : "space-between",
              px: collapsed ? 0 : 2,
              py: 1,
              borderBottomWidth: 1,
              borderBottomStyle: "solid",
              borderBottomColor: "border.muted",
              bg: "canvas.subtle",
            }}
          >
            {!collapsed && (
              <Text sx={{ fontSize: 0, color: "fg.muted", fontWeight: 600 }}>
                Run · {detail.run.status}
              </Text>
            )}
            <IconButton
              aria-label={collapsed ? "Expand phases" : "Collapse phases"}
              icon={collapsed ? ChevronRightIcon : ChevronLeftIcon}
              variant="invisible"
              size="small"
              onClick={() => setCollapsed((c) => !c)}
            />
          </Box>
          <Box>
            {detail.phases.map((p, i) => (
              <PhaseRow
                key={p.id}
                phase={p}
                last={i === detail.phases.length - 1}
                collapsed={collapsed}
                selected={p.id === selectedPhaseId}
                busy={busy}
                onSelect={() => setSelectedPhaseId(p.id)}
                onComplete={() => complete(p.id)}
                onApprove={() => approve(p.id)}
                onRewind={rewindToImplementation}
              />
            ))}
          </Box>
        </Box>

        {/* Content area for the selected phase */}
        <Box
          sx={{
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "border.default",
            borderRadius: 2,
            bg: "canvas.default",
            minHeight: 400,
            display: "flex",
            flexDirection: "column",
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

function PhaseRow({
  phase,
  last,
  collapsed,
  selected,
  busy,
  onSelect,
  onComplete,
  onApprove,
  onRewind,
}: {
  phase: Phase;
  last: boolean;
  collapsed: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onComplete: () => void;
  onApprove: () => void;
  onRewind: () => void;
}) {
  const color = STATE_COLORS[phase.status] ?? "#6e7681";
  // Review can send the work back to Implementation when it finds issues.
  // For the M3 mock we expose this on the Review row when it's running or
  // waiting; clicking rewinds to Implementation (ord 2).
  const canRewindToImpl = phase.kind === "review" &&
    (phase.status === "running" || phase.status === "waiting");

  return (
    <Box
      onClick={onSelect}
      sx={{
        display: "flex",
        gap: 2,
        cursor: "pointer",
        bg: selected ? "accent.subtle" : "transparent",
        borderLeftWidth: 3,
        borderLeftStyle: "solid",
        borderLeftColor: selected ? "accent.fg" : "transparent",
        borderBottomWidth: last ? 0 : 1,
        borderBottomStyle: "solid",
        borderBottomColor: "border.muted",
        transition: "background-color 80ms",
        "&:hover": { bg: selected ? "accent.subtle" : "canvas.subtle" },
      }}
    >
      {/* Status dot rail */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: collapsed ? 40 : 24,
          flexShrink: 0,
          pt: "14px",
        }}
      >
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
      </Box>

      {!collapsed && (
        <Box sx={{ flex: 1, minWidth: 0, py: 2, pr: 2 }}>
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
                  Send Back to Implementation
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
                  Send Back to Implementation
                </Button>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

function PhaseContent({
  phase,
  tab,
  onTabChange,
}: {
  phase: Phase;
  tab: ContentTab;
  onTabChange: (t: ContentTab) => void;
}) {
  // Document and Diff aren't relevant for every phase; we always expose
  // Chat though (that's where the session thinking goes).
  const tabs: { id: ContentTab; label: string; icon: typeof FileIcon }[] = [
    { id: "document", label: "Document", icon: FileIcon },
    { id: "diff", label: "Diff", icon: FileDiffIcon },
    { id: "chat", label: "Chat", icon: CommentDiscussionIcon },
  ];

  return (
    <>
      <Box
        sx={{
          px: 3,
          pt: 3,
          pb: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "baseline", gap: 2 }}>
          <Text sx={{ fontWeight: 600, fontSize: 2 }}>
            {PHASE_LABELS[phase.kind] ?? phase.kind}
          </Text>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>
            · {STATE_LABELS[phase.status] ?? phase.status}
          </Text>
        </Box>
        <TabStrip<ContentTab> tabs={tabs} active={tab} onChange={onTabChange} />
      </Box>

      <Box sx={{ p: 4, flex: 1, color: "fg.muted" }}>
        {tab === "document" && (
          <Text>
            Generated context / plan document for this phase will appear here.
          </Text>
        )}
        {tab === "diff" && (
          <Text>
            Code diffs produced by the implementation session will appear here.
          </Text>
        )}
        {tab === "chat" && (
          <Text>
            Session chat &amp; thinking will stream in here. You'll be able to
            inject prompts to steer the agent.
          </Text>
        )}
        <Text sx={{ display: "block", mt: 3, fontSize: 0 }}>
          (Wires up in M4 when sessions ship.)
        </Text>
      </Box>
    </>
  );
}
