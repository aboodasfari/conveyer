import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Box, Button, Heading, Link as PrimerLink, Spinner, Text } from "@primer/react";
import { LinkExternalIcon } from "@primer/octicons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { TaskSummary } from "../types";
import { StatusBadge } from "../components/StatusBadge";

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const all = await api.tasksList();
      setTask(all.find((t) => t.id === id) ?? null);
      setLoading(false);
    })();
  }, [id]);

  if (loading) {
    return <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}><Spinner /></Box>;
  }
  if (!task) {
    return (
      <Box>
        <Text>Task not found.</Text>{" "}
        <PrimerLink as={Link} to="/">Back to dashboard</PrimerLink>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box>
        <Text sx={{ color: "fg.muted", fontSize: 0 }}>#{task.source_ref} · {task.state}</Text>
        <Heading as="h1" sx={{ fontSize: 4, mt: 1 }}>{task.title}</Heading>
        <Box sx={{ mt: 2, display: "flex", gap: 2, alignItems: "center" }}>
          <StatusBadge status={task.run_status} />
          <Button leadingVisual={LinkExternalIcon} onClick={() => openUrl(task.url)}>
            Open in source
          </Button>
        </Box>
      </Box>

      <Box
        sx={{
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "border.default",
          borderRadius: 2,
          p: 4,
        }}
      >
        <Heading as="h2" sx={{ fontSize: 2, mb: 2 }}>Run</Heading>
        <Text sx={{ color: "fg.muted" }}>
          No run yet. The Tackle button will start a run once the session runner ships in M4.
        </Text>
      </Box>
    </Box>
  );
}
