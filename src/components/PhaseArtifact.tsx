import { useCallback, useEffect, useState } from "react";
import { Box, Spinner } from "@primer/react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { RichText } from "./RichText";
import { TabPlaceholder } from "./TabPlaceholder";

interface RunUpdated {
  task_id: string;
  run_id: string;
}

/**
 * Renders the captured artifact for a phase. Re-fetches when the backend
 * emits run_updated, so the document appears as soon as the sidecar
 * writes it.
 */
export function PhaseArtifact({
  phaseId,
  taskId,
  emptyHint,
}: {
  phaseId: string;
  taskId: string;
  emptyHint: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setContent(await api.phaseArtifactGet(phaseId));
    } finally {
      setLoading(false);
    }
  }, [phaseId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<RunUpdated>("run_updated", (e) => {
        if (e.payload.task_id === taskId) void load();
      });
      if (cancelled) unlisten();
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [taskId, load]);

  if (loading) return <Spinner size="small" />;
  if (!content || !content.trim()) {
    return <TabPlaceholder title={emptyHint} />;
  }
  return (
    <Box sx={{ height: "100%", overflowY: "auto" }}>
      <RichText content={content} />
    </Box>
  );
}
