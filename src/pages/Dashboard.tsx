import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Flash,
  FormControl,
  Heading,
  Spinner,
  Text,
  Textarea,
  TextInput,
} from "@primer/react";
import { PlusIcon, SyncIcon } from "@primer/octicons-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAutoRefresh } from "../autoRefresh";
import { Bucket, Source, TaskSummary } from "../types";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { TaskTree } from "../components/TaskTree";
import { WorkspaceCombobox } from "../components/WorkspaceCombobox";
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

  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newWorkspace, setNewWorkspace] = useState("");
  const [creating, setCreating] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TaskSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const nav = useNavigate();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, s] = await Promise.all([api.tasksList(), api.sourcesList()]);
      setTasks(t);
      // `local` is the always-on built-in source for ad-hoc tasks — it
      // doesn't pull from anywhere, so exclude it from the "external
      // sources" list used by Refresh / Add by URL.
      setSources(s.filter((x) => x.enabled && x.kind !== "local"));
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
      // Same signal the auto-poller uses so other listeners (e.g. the
      // notification hook) see new tasks discovered by a manual refresh.
      window.dispatchEvent(new CustomEvent("conveyer:sources-refreshed"));
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

  const closeNew = () => {
    setNewOpen(false);
    setNewTitle("");
    setNewDesc("");
    setNewWorkspace("");
    setNewError(null);
  };

  const createLocal = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    setNewError(null);
    try {
      const id = await api.tasksCreateLocal(
        title,
        newDesc.trim() || null,
        newWorkspace.trim() || null,
      );
      closeNew();
      await load();
      nav(`/tasks/${id}`);
    } catch (e) {
      setNewError(formatError(e));
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    setDeleteError(null);
    try {
      await api.tasksDelete(deleting.id);
      setDeleting(null);
      await load();
    } catch (e) {
      setDeleteError(formatError(e));
    } finally {
      setDeletingBusy(false);
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
            <>
              <Button
                leadingVisual={PlusIcon}
                variant="primary"
                onClick={() => setNewOpen(true)}
              >
                New task
              </Button>
              <Button
                leadingVisual={PlusIcon}
                onClick={() => setAddOpen(true)}
                disabled={sources.length === 0}
              >
                Add by URL
              </Button>
            </>
          )}
          <Button
            leadingVisual={SyncIcon}
            onClick={refresh}
            disabled={sources.length === 0 || refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </Box>
      </Box>

      {error && <Flash variant="danger">{error}</Flash>}

      {visible.length === 0 ? (
        <EmptyState
          title={`Nothing in ${TITLES[bucket]}`}
          body={
            bucket === "active"
              ? "Create a local task with the New task button, or add one from an external source."
              : EMPTY_BODY[bucket]
          }
        />
      ) : (
        <TaskTree tasks={visible} onMove={move} onDelete={(t) => setDeleting(t)} />
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

      <Modal
        open={newOpen}
        title="New task"
        width={640}
        error={newError}
        onClose={() => closeNew()}
        footer={
          <>
            <Button onClick={() => closeNew()}>Cancel</Button>
            <Button
              variant="primary"
              onClick={createLocal}
              disabled={!newTitle.trim() || creating}
            >
              {creating ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <Box
          sx={{ display: "flex", flexDirection: "column", gap: 3 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void createLocal();
            }
          }}
        >
          <FormControl required>
            <FormControl.Label>Title</FormControl.Label>
            <TextInput
              block
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </FormControl>
          <FormControl>
            <FormControl.Label>Description</FormControl.Label>
            <FormControl.Caption>
              What needs to happen. The agent reads this in the exploration phase.
            </FormControl.Caption>
            <Textarea
              block
              rows={6}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              resize="vertical"
              sx={{ fontFamily: "mono", fontSize: 1 }}
            />
          </FormControl>
          <FormControl>
            <FormControl.Label>Workspace (optional)</FormControl.Label>
            <FormControl.Caption>
              Pin to a specific workspace, or leave blank and let the agent pick during exploration.
            </FormControl.Caption>
            <WorkspaceCombobox value={newWorkspace} onChange={setNewWorkspace} />
          </FormControl>
          <Text sx={{ fontSize: 0, color: "fg.muted" }}>
            Tip: ⌘+Enter to create.
          </Text>
        </Box>
      </Modal>

      <Modal
        open={deleting !== null}
        title="Delete task?"
        width={420}
        error={deleteError}
        onClose={() => { setDeleting(null); setDeleteError(null); }}
        footer={
          <>
            <Button onClick={() => { setDeleting(null); setDeleteError(null); }}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => void confirmDelete()}
              disabled={deletingBusy}
            >
              {deletingBusy ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Box
            sx={{
              px: 2,
              py: 2,
              bg: "canvas.subtle",
              borderLeftWidth: 3,
              borderLeftStyle: "solid",
              borderLeftColor: "border.default",
              borderRadius: 1,
            }}
          >
            <Text sx={{ fontWeight: 600, wordBreak: "break-word" }}>
              {deleting?.title}
            </Text>
          </Box>
          <Text>Permanently deletes its runs, chat, and artifacts.</Text>
          <Text sx={{ color: "fg.muted" }}>This can't be undone.</Text>
          {deleting?.source_id && deleting.source_id !== "local" && (
            <Text sx={{ fontSize: 0, color: "attention.fg" }}>
              From an external source — the next refresh may bring it back. Archive to hide instead.
            </Text>
          )}
        </Box>
      </Modal>
    </Box>
  );
}
