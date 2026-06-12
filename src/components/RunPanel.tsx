import { useCallback, useEffect, useState } from "react";
import { Box, Button, Flash, Spinner, Text } from "@primer/react";
import { CheckIcon, PlayIcon } from "@primer/octicons-react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { Phase, RunDetail } from "../types";
import { formatError } from "../errors";

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

interface RunUpdatedPayload {
  task_id: string;
  run_id: string;
}

export function RunPanel({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      // The simplest way to find the current run for a task: pull the list
      // and take the freshest. (We could expose a runs_latest IPC later.)
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

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.runsStart(taskId);
      setDetail(d);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const complete = async (phaseId: string) => {
    setBusy(true);
    setError(null);
    try {
      setDetail(await api.phaseComplete(phaseId));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = async (phaseId: string) => {
    setBusy(true);
    setError(null);
    try {
      setDetail(await api.phaseApprove(phaseId));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner size="small" />;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {error && <Flash variant="danger">{error}</Flash>}

      {!detail ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
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
      ) : (
        <>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Text sx={{ fontWeight: 600 }}>Run</Text>
            <Text sx={{ color: "fg.muted", fontSize: 0 }}>
              · {detail.run.status}
            </Text>
          </Box>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {detail.phases.map((p, i) => (
              <PhaseRow
                key={p.id}
                phase={p}
                last={i === detail.phases.length - 1}
                busy={busy}
                onComplete={() => complete(p.id)}
                onApprove={() => approve(p.id)}
              />
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}

function PhaseRow({
  phase,
  last,
  busy,
  onComplete,
  onApprove,
}: {
  phase: Phase;
  last: boolean;
  busy: boolean;
  onComplete: () => void;
  onApprove: () => void;
}) {
  const color = STATE_COLORS[phase.status] ?? "#6e7681";
  return (
    <Box sx={{ display: "flex", gap: 3, alignItems: "stretch" }}>
      {/* Timeline rail */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: 24,
          flexShrink: 0,
        }}
      >
        <Box
          sx={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            bg: color,
            mt: "10px",
            flexShrink: 0,
            boxShadow:
              phase.status === "running"
                ? "0 0 0 4px rgba(31,111,235,0.25)"
                : "none",
          }}
        />
        {!last && (
          <Box
            sx={{
              flex: 1,
              width: 2,
              bg: "border.muted",
              mt: 1,
              mb: 1,
              minHeight: 24,
            }}
          />
        )}
      </Box>

      {/* Row content */}
      <Box sx={{ flex: 1, py: 2, pb: 3 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
          <Text sx={{ fontWeight: 600 }}>
            {PHASE_LABELS[phase.kind] ?? phase.kind}
          </Text>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>
            · {phase.status === "waiting" ? "done, awaiting approval" : phase.status}
          </Text>
        </Box>
        {phase.status === "running" && (
          <Button
            leadingVisual={CheckIcon}
            size="small"
            onClick={onComplete}
            disabled={busy}
          >
            Mark Complete
          </Button>
        )}
        {phase.status === "waiting" && (
          <Button
            leadingVisual={CheckIcon}
            variant="primary"
            size="small"
            onClick={onApprove}
            disabled={busy}
          >
            Approve
          </Button>
        )}
      </Box>
    </Box>
  );
}
