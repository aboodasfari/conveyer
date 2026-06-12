import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  Flash,
  Heading,
  Link as PrimerLink,
  Spinner,
  Text,
  TextInput,
} from "@primer/react";
import { PlusIcon, SyncIcon, PlayIcon } from "@primer/octicons-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Source, TaskSummary } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";

export function Dashboard() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addUrl, setAddUrl] = useState("");

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
    setError(null);
    try {
      await api.tasksAddByUrl(sources[0].id, addUrl.trim());
      setAddUrl("");
      await load();
    } catch (e) {
      setError(String(e));
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
            leadingVisual={SyncIcon}
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
      ) : (
        <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
          <TextInput
            block
            placeholder="Add a task by URL"
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            sx={{ flex: 1 }}
          />
          <Button leadingVisual={PlusIcon} onClick={addByUrl} disabled={!addUrl.trim()}>
            Add
          </Button>
        </Box>
      )}

      {tasks.length === 0 && sources.length > 0 ? (
        <EmptyState
          title="No tasks yet"
          body="Click Refresh to poll your source, or add a task by URL above."
        />
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function TaskRow({ task }: { task: TaskSummary }) {
  return (
    <Box
      sx={{
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        p: 3,
        display: "flex",
        alignItems: "center",
        gap: 3,
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
          <PrimerLink as={Link} to={`/tasks/${task.id}`} sx={{ fontWeight: "bold" }}>
            {task.title || `#${task.source_ref}`}
          </PrimerLink>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>#{task.source_ref}</Text>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>{task.state}</Text>
          <StatusBadge status={task.run_status} />
        </Box>
      </Box>
      <Button leadingVisual={PlayIcon} variant="primary" disabled>
        Tackle
      </Button>
    </Box>
  );
}
