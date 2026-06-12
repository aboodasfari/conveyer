import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Flash,
  Heading,
  SegmentedControl,
  Spinner,
  TextInput,
} from "@primer/react";
import { PlusIcon, SyncIcon } from "@primer/octicons-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Bucket, BUCKETS, Source, TaskSummary } from "../types";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { TaskTree } from "../components/TaskTree";

const BUCKET_LABELS: Record<Bucket, string> = {
  active: "Active",
  backlog: "Backlog",
  archive: "Archive",
};

export function Dashboard() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [bucket, setBucket] = useState<Bucket>("active");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, s] = await Promise.all([api.tasksList(), api.sourcesList()]);
      setTasks(t);
      setSources(s.filter((x) => x.enabled));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    if (sources.length === 0) return;
    setRefreshing(true);
    setError(null);
    try {
      for (const s of sources) await api.tasksRefresh(s.id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const addByUrl = async () => {
    if (sources.length === 0 || !addUrl.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await api.tasksAddByUrl(sources[0].id, addUrl.trim());
      setAddUrl("");
      setAddOpen(false);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const move = async (taskId: string, to: Bucket) => {
    try {
      await api.tasksSetBucket(taskId, to);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const counts = useMemo(() => {
    // Count visible roots per bucket so the user knows where stuff is.
    const c: Record<Bucket, number> = { active: 0, backlog: 0, archive: 0 };
    const refsBySource = new Map<string, Set<string>>();
    for (const t of tasks) {
      let set = refsBySource.get(t.source_id);
      if (!set) { set = new Set(); refsBySource.set(t.source_id, set); }
      set.add(t.source_ref);
    }
    for (const t of tasks) {
      const isRoot = !t.parent_ref || !refsBySource.get(t.source_id)?.has(t.parent_ref);
      if (isRoot) c[t.bucket as Bucket]++;
    }
    return c;
  }, [tasks]);

  const visible = useMemo(() => {
    // A child shows iff its root is in the active bucket; for orphaned
    // children, just use the child's own bucket.
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
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Heading as="h1" sx={{ fontSize: 4 }}>Tasks</Heading>
        <Box sx={{ display: "flex", gap: 2 }}>
          <Button
            leadingVisual={PlusIcon}
            onClick={() => setAddOpen(true)}
            disabled={sources.length === 0}
          >
            Add by URL
          </Button>
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

      <SegmentedControl aria-label="Bucket" size="small">
        {BUCKETS.map((b) => (
          <SegmentedControl.Button
            key={b}
            selected={bucket === b}
            onClick={() => setBucket(b)}
          >
            {`${BUCKET_LABELS[b]} (${counts[b]})`}
          </SegmentedControl.Button>
        ))}
      </SegmentedControl>

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
          title={`Nothing in ${BUCKET_LABELS[bucket]}`}
          body={
            bucket === "active"
              ? "Click Refresh to poll your source, or move something here from Backlog/Archive."
              : `Move stories here from Active via the move menu.`
          }
        />
      ) : (
        <TaskTree tasks={visible} onMove={move} />
      )}

      <Modal
        open={addOpen}
        title="Add task by URL"
        onClose={() => { setAddOpen(false); setAddUrl(""); }}
        footer={
          <>
            <Button onClick={() => { setAddOpen(false); setAddUrl(""); }}>Cancel</Button>
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
