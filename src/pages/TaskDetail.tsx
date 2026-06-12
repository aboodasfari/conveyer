import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Heading,
  IconButton,
  Link as PrimerLink,
  Spinner,
  Text,
} from "@primer/react";
import { ArrowLeftIcon, LinkExternalIcon, PlayIcon, FileIcon } from "@primer/octicons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { TaskSummary } from "../types";
import { StatusBadge } from "../components/StatusBadge";
import { RichText } from "../components/RichText";
import { RunPanel } from "../components/RunPanel";
import { TabStrip } from "../components/TabStrip";

type Tab = "description" | "run";

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [parent, setParent] = useState<TaskSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("description");

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
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minHeight: 0 }}>
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
          <StatusBadge status={task.run_status} phase={task.current_phase} />
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

      <TabStrip<Tab>
        tabs={[
          { id: "description", label: "Description", icon: FileIcon },
          { id: "run", label: "Run", icon: PlayIcon },
        ]}
        active={tab}
        onChange={setTab}
      />

      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "description" ? (
          <RichText content={task.description} />
        ) : (
          <RunPanel taskId={task.id} />
        )}
      </Box>
    </Box>
  );
}
