import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Box, Button, Heading, IconButton, Link as PrimerLink, Spinner, Text } from "@primer/react";
import { ArrowLeftIcon, LinkExternalIcon } from "@primer/octicons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { TaskSummary } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { RichText } from "../components/RichText";

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [parent, setParent] = useState<TaskSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const all = await api.tasksList();
      const t = all.find((x) => x.id === id) ?? null;
      setTask(t);
      if (t?.parent_ref) {
        setParent(
          all.find(
            (x) => x.source_id === t.source_id && x.source_ref === t.parent_ref,
          ) ?? null,
        );
      } else {
        setParent(null);
      }
      setLoading(false);
    })();
  }, [id]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <Spinner />
      </Box>
    );
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
      <Button
        leadingVisual={ArrowLeftIcon}
        variant="invisible"
        onClick={() => (window.history.length > 1 ? nav(-1) : nav("/"))}
        sx={{ alignSelf: "flex-start", px: 1, mt: -2 }}
      >
        Back
      </Button>

      <Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>#{task.source_ref}</Text>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>·</Text>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>{task.state}</Text>
          <StatusBadge status={task.run_status} />
        </Box>
        <Box sx={{ mt: 1, display: "flex", alignItems: "center", gap: 2 }}>
          <Heading as="h1" sx={{ fontSize: 4 }}>{task.title}</Heading>
          <IconButton
            aria-label="Open in source"
            title="Open in source"
            icon={LinkExternalIcon}
            variant="invisible"
            onClick={() => openUrl(task.url)}
          />
        </Box>
        {parent && (
          <Text sx={{ display: "block", color: "fg.muted", fontSize: 0, mt: 1 }}>
            Under{" "}
            <PrimerLink as={Link} to={`/tasks/${parent.id}`}>
              {parent.title} (#{parent.source_ref})
            </PrimerLink>
          </Text>
        )}
      </Box>

      <Section title="Description">
        <RichText content={task.description} />
      </Section>

      <Section title="Run">
        <Text sx={{ color: "fg.muted" }}>
          No run yet. Tackle wires up in M3.
        </Text>
      </Section>
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box
      sx={{
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        p: 4,
      }}
    >
      <Heading as="h2" sx={{ fontSize: 2, mb: 2 }}>{title}</Heading>
      {children}
    </Box>
  );
}
