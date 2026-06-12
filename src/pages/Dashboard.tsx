import { useCallback, useEffect, useState } from "react";
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
import { Source, TaskSummary } from "../types";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { TaskTree } from "../components/TaskTree";

export function Dashboard() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);

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

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    if (sources.length === 0) return;
    setRefreshing(true);
    setError(null);
    try {
      for (const s of sources) {
        await api.tasksRefresh(s.id);
      }
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
      ) : tasks.length === 0 ? (
        <EmptyState
          title="No tasks yet"
          body="Click Refresh to poll your source, or Add by URL."
        />
      ) : (
        <TaskTree tasks={tasks} />
      )}

      <Modal
        open={addOpen}
        title="Add task by URL"
        onClose={() => {
          setAddOpen(false);
          setAddUrl("");
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setAddOpen(false);
                setAddUrl("");
              }}
            >
              Cancel
            </Button>
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
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <TextInput
            block
            autoFocus
            placeholder="https://dev.azure.com/.../_workitems/edit/12345"
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addByUrl();
            }}
          />
        </Box>
      </Modal>
    </Box>
  );
}
