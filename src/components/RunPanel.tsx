import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Flash, IconButton, Spinner, Text } from "@primer/react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  CopilotIcon,
  FileDiffIcon,
  FileIcon,
  GitPullRequestIcon,
  PlayIcon,
  ReplyIcon,
  ScreenFullIcon,
  ScreenNormalIcon,
  StopIcon,
  SyncIcon,
} from "@primer/octicons-react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { Phase, RunDetail } from "../types";
import { formatError } from "../errors";
import { TabStrip } from "./TabStrip";
import { PhaseChat } from "./PhaseChat";
import { PhaseArtifact } from "./PhaseArtifact";
import { PromptView } from "./PromptView";
import { DiffViewer } from "./DiffViewer";

const RING_PULSE_KEYFRAMES = `
@keyframes conveyerRingPulse {
  0%   { box-shadow: 0 0 0 0   rgba(31,111,235,0.45); }
  70%  { box-shadow: 0 0 0 8px rgba(31,111,235,0);    }
  100% { box-shadow: 0 0 0 0   rgba(31,111,235,0);    }
}
/* Primer's Portal renders to #__primerPortalRoot__ on body — bump its
 * z-index above our fullscreen overlay (z-index 5) so menus/dropdowns
 * are clickable in fullscreen mode. */
#__primerPortalRoot__ { position: relative; z-index: 1000; }
`;
if (typeof document !== "undefined" && !document.getElementById("conveyer-ring-pulse-kf")) {
  const style = document.createElement("style");
  style.id = "conveyer-ring-pulse-kf";
  style.textContent = RING_PULSE_KEYFRAMES;
  document.head.appendChild(style);
}

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

const PROMPT_TAB: ContentTab = {
  id: "prompt",
  label: "Prompt",
  icon: CopilotIcon,
};

/**
 * Each phase has its own dedicated content tab(s) plus a Chat tab where
 * the session thinking will surface in M4.
 */
const PHASE_TABS: Record<string, ContentTab[]> = {
  exploration: [{ id: "context", label: "Context", icon: FileIcon }, CHAT_TAB, PROMPT_TAB],
  planning: [{ id: "plan", label: "Plan", icon: FileIcon }, CHAT_TAB, PROMPT_TAB],
  implementation: [{ id: "diff", label: "Diff", icon: FileDiffIcon }, CHAT_TAB, PROMPT_TAB],
  review: [{ id: "review", label: "Review", icon: FileIcon }, CHAT_TAB, PROMPT_TAB],
  submit: [{ id: "pr", label: "Pull Request", icon: GitPullRequestIcon }, CHAT_TAB, PROMPT_TAB],
};

const PLACEHOLDERS: Record<string, string> = {
  context: "The exploration context document will show up here once the phase starts.",
  plan: "The implementation plan will show up here once the planning phase starts.",
  diff: "Code diffs will show up here once the implementation phase starts.",
  review: "Review findings will show up here once the review phase starts.",
  pr: "The pull request URL and check status will show up here once submit runs.",
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
  const [fullscreen, setFullscreen] = useState(false);

  // Keyboard shortcuts: 'f' toggles fullscreen, Esc exits. Skip when a
  // text input is focused, or when an open Primer overlay is going to
  // handle the key itself (so the dropdown can close first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      // Skip if an overlay (e.g. ActionMenu) is open — let it handle Esc.
      if (document.querySelector('[role="menu"], [role="dialog"], [data-state="open"]')) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setFullscreen(false);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setFullscreen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
  const restart = (id: string) => wrap(async () => api.phaseRestart(id));

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
    // Use `height` so the panel is exactly the viewport minus the chrome
    // above it. Subtracted: 48 header + 64 main padding + ~80 title block
    // + ~40 tabs + ~28 back button + ~80 gap = ~340.
    <Box
      sx={fullscreen ? {
        position: "fixed",
        top: 48,                // leave the app's top nav visible
        left: 0, right: 0, bottom: 0,
        zIndex: 5,              // above page content, below Primer portals
        bg: "canvas.default",
        p: 3,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      } : {
        display: "flex",
        flexDirection: "column",
        gap: 2,
        height: "calc(100vh - 300px)",
        minHeight: 440,
      }}
    >
      {error && <Flash variant="danger">{error}</Flash>}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: fullscreen ? "1fr" : (collapsed ? "40px 1fr" : "300px 1fr"),
          gridTemplateRows: "1fr",
          gap: 3,
          alignItems: "stretch",
          flex: 1,
          minHeight: 0,
          transition: "grid-template-columns 200ms ease",
        }}
      >
        {!fullscreen && (collapsed ? (
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
            onCancel={complete}
            onApprove={approve}
            onRewind={rewindToImplementation}
            onRestart={restart}
          />
        ))}

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
              taskId={taskId}
              tab={contentTab}
              onTabChange={setContentTab}
              fullscreen={fullscreen}
              onToggleFullscreen={() => setFullscreen((f) => !f)}
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
  onCancel,
  onApprove,
  onRewind,
  onRestart,
}: {
  detail: RunDetail;
  selectedPhaseId: string | null;
  busy: boolean;
  onCollapse: () => void;
  onSelect: (id: string) => void;
  onCancel: (id: string) => void;
  onApprove: (id: string) => void;
  onRewind: () => void;
  onRestart: (id: string) => void;
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
            onCancel={() => onCancel(p.id)}
            onApprove={() => onApprove(p.id)}
            onRewind={onRewind}
            onRestart={() => onRestart(p.id)}
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
  onCancel,
  onApprove,
  onRewind,
  onRestart,
}: {
  phase: Phase;
  first: boolean;
  last: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onCancel: () => void;
  onApprove: () => void;
  onRewind: () => void;
  onRestart: () => void;
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
            animation:
              phase.status === "running"
                ? "conveyerRingPulse 1.6s ease-out infinite"
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
              leadingVisual={StopIcon}
              size="small"
              variant="danger"
              onClick={(e) => { e.stopPropagation(); onCancel(); }}
              disabled={busy}
              title="Cancel the agent and mark the phase done"
            >
              Stop Agent
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
        {(phase.status === "failed" || phase.status === "cancelled") && (
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button
              leadingVisual={SyncIcon}
              size="small"
              variant="primary"
              onClick={(e) => { e.stopPropagation(); onRestart(); }}
              disabled={busy}
              title="Clear this phase's prior messages and start it again"
            >
              Restart
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function PhaseContent({
  phase,
  taskId,
  tab,
  onTabChange,
  fullscreen,
  onToggleFullscreen,
}: {
  phase: Phase;
  taskId: string;
  tab: string;
  onTabChange: (t: string) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const tabs = PHASE_TABS[phase.kind] ?? [CHAT_TAB];

  return (
    <>
      <Box
        sx={{
          px: 3,
          pt: 3,
          flexShrink: 0,
          display: "flex",
          alignItems: "flex-end",
          gap: 2,
          borderBottomWidth: 1,
          borderBottomStyle: "solid",
          borderBottomColor: "border.default",
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0, mb: "-1px" }}>
          <TabStrip<string> tabs={tabs} active={tab} onChange={onTabChange} noUnderline />
        </Box>
        <Box sx={{ pb: 1 }}>
          <IconButton
            aria-label={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen (F)"}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen (F)"}
            icon={fullscreen ? ScreenNormalIcon : ScreenFullIcon}
            variant="invisible"
            size="small"
            onClick={onToggleFullscreen}
          />
        </Box>
      </Box>
      <Box sx={{ p: 4, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "chat" ? (
          <PhaseChat phaseId={phase.id} />
        ) : tab === "diff" ? (
          <DiffViewer phaseId={phase.id} />
        ) : tab === "prompt" ? (
          <PromptView phaseId={phase.id} />
        ) : (
          <PhaseArtifact
            phaseId={phase.id}
            taskId={taskId}
            emptyHint={PLACEHOLDERS[tab] ?? ""}
          />
        )}
      </Box>
    </>
  );
}
