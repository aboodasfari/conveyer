import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Flash,
  Heading,
  Spinner,
  TextInput,
} from "@primer/react";
import { PlusIcon, SyncIcon } from "@primer/octicons-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAutoRefresh } from "../autoRefresh";
import { Bucket, Source, TaskSummary } from "../types";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { TaskTree } from "../components/TaskTree";
import { formatError } from "../errors";

const TITLES: Record<Bucket, string> = {
  active: "Active",
  backlog: "Backlog",
  archive: "Archive",
};

const EMPTY_BODY: Record<Bucket, string> = {
  active: "Refresh to pull from your source, or add by URL.",
  backlog: "Move stories here from Active when they're not your focus today.",
  archive: "Move stories here when you're done.",
};

export function Dashboard({ bucket }: { bucket: Bucket }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, s] = await Promise.all([api.tasksList(), api.sourcesList()]);
      setTasks(t);
      setSources(s.filter((x) => x.enabled));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(load);

  const refresh = async () => {
    if (sources.length === 0) return;
    setRefreshing(true);
    setError(null);
    try {
      for (const s of sources) await api.tasksRefresh(s.id);
      await load();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setRefreshing(false);
    }
  };

  const addByUrl = async () => {
    if (sources.length === 0 || !addUrl.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.tasksAddByUrl(sources[0].id, addUrl.trim());
      setAddUrl("");
      setAddOpen(false);
      await load();
    } catch (e) {
      setAddError(formatError(e));
    } finally {
      setAdding(false);
    }
  };

  const move = async (taskId: string, to: Bucket) => {
    try {
      await api.tasksSetBucket(taskId, to);
      await load();
    } catch (e) {
      setError(formatError(e));
    }
  };

  // Filter to this bucket — children inherit their root's bucket if their
  // root is in the visible set, otherwise show by their own bucket.
  const visible = useMemo(() => {
    const bySrcRef = new Map<string, TaskSummary>();
    for (const t of tasks) bySrcRef.set(`${t.source_id}::${t.source_ref}`, t);
    return tasks.filter((t) => {
      const root = t.parent_ref ? bySrcRef.get(`${t.source_id}::${t.parent_ref}`) : t;
      return (root ?? t).bucket === bucket;
    });
  }, [tasks, bucket]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <Spinner />
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Heading as="h1" sx={{ fontSize: 4 }}>{TITLES[bucket]}</Heading>
        <Box sx={{ display: "flex", gap: 2 }}>
          {bucket === "active" && (
            <Button
              leadingVisual={PlusIcon}
              onClick={() => setAddOpen(true)}
              disabled={sources.length === 0}
            >
              Add by URL
            </Button>
          )}
          <Button
            leadingVisual={SyncIcon}
            variant="primary"
            onClick={refresh}
            disabled={sources.length === 0 || refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </Box>
      </Box>

      {error && <Flash variant="danger">{error}</Flash>}

      {sources.length === 0 ? (
        <EmptyState
          title="No source configured"
          body="Add an Azure DevOps source in Settings to start discovering tasks."
          action={
            <Button as={Link} to="/settings" variant="primary">
              Open Settings
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title={`Nothing in ${TITLES[bucket]}`}
          body={EMPTY_BODY[bucket]}
        />
      ) : (
        <TaskTree tasks={visible} onMove={move} />
      )}

      <Modal
        open={addOpen}
        title="Add Task by URL"
        error={addError}
        onClose={() => { setAddOpen(false); setAddUrl(""); setAddError(null); }}
        footer={
          <>
            <Button onClick={() => { setAddOpen(false); setAddUrl(""); setAddError(null); }}>Cancel</Button>
            <Button
              variant="primary"
              onClick={addByUrl}
              disabled={!addUrl.trim() || adding}
            >
              {adding ? "Adding…" : "Add"}
            </Button>
          </>
        }
      >
        <TextInput
          block
          autoFocus
          placeholder="https://dev.azure.com/.../_workitems/edit/12345"
          value={addUrl}
          onChange={(e) => setAddUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void addByUrl(); }}
        />
      </Modal>
    </Box>
  );
}
