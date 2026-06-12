import { useMemo, useState } from "react";
import {
  ActionList,
  ActionMenu,
  Box,
  Button,
  IconButton,
  Label,
  Link as PrimerLink,
  Text,
} from "@primer/react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  KebabHorizontalIcon,
  PlayIcon,
} from "@primer/octicons-react";
import { Link } from "react-router-dom";
import { Bucket, TaskSummary } from "../types";
import { StatusBadge } from "./StatusBadge";
import { StateChip } from "./StateChip";

interface Node {
  task: TaskSummary;
  children: TaskSummary[];
}

const MOVE_TARGETS: { value: Bucket; label: string }[] = [
  { value: "active", label: "Move to Active" },
  { value: "backlog", label: "Move to Backlog" },
  { value: "archive", label: "Move to Archive" },
];

export function TaskTree({
  tasks,
  onMove,
}: {
  tasks: TaskSummary[];
  onMove?: (taskId: string, to: Bucket) => void;
}) {
  const nodes = useMemo<Node[]>(() => {
    const bySourceRef = new Map<string, TaskSummary>();
    for (const t of tasks) bySourceRef.set(t.source_ref, t);

    const childrenByParent = new Map<string, TaskSummary[]>();
    const rootIds = new Set<string>();

    for (const t of tasks) {
      if (t.parent_ref && bySourceRef.has(t.parent_ref)) {
        const arr = childrenByParent.get(t.parent_ref) ?? [];
        arr.push(t);
        childrenByParent.set(t.parent_ref, arr);
      } else {
        rootIds.add(t.source_ref);
      }
    }
    return tasks
      .filter((t) => rootIds.has(t.source_ref))
      .map((t) => ({ task: t, children: childrenByParent.get(t.source_ref) ?? [] }));
  }, [tasks]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {nodes.map((n) => (
        <StoryCard key={n.task.id} node={n} onMove={onMove} />
      ))}
    </Box>
  );
}

function StoryCard({
  node,
  onMove,
}: {
  node: Node;
  onMove?: (taskId: string, to: Bucket) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <Box
      sx={{
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        overflow: "hidden",
        bg: "canvas.default",
        boxShadow: "shadow.small",
      }}
    >
      <StoryHeader
        task={node.task}
        toggle={hasChildren ? (
          <IconButton
            aria-label={open ? "Collapse" : "Expand"}
            icon={open ? ChevronDownIcon : ChevronRightIcon}
            variant="invisible"
            size="small"
            onClick={() => setOpen((o) => !o)}
          />
        ) : (
          <Box sx={{ width: 28 }} />
        )}
        menu={onMove ? (
          <ActionMenu>
            <ActionMenu.Anchor>
              <IconButton aria-label="Move" icon={KebabHorizontalIcon} variant="invisible" />
            </ActionMenu.Anchor>
            <ActionMenu.Overlay align="end">
              <ActionList>
                {MOVE_TARGETS.filter((m) => m.value !== node.task.bucket).map((m) => (
                  <ActionList.Item
                    key={m.value}
                    onSelect={() => onMove(node.task.id, m.value)}
                  >
                    {m.label}
                  </ActionList.Item>
                ))}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        ) : null}
      />
      {hasChildren && open && (
        <Box sx={{ bg: "canvas.inset" }}>
          {node.children.map((c, i) => (
            <ChildRow
              key={c.id}
              task={c}
              last={i === node.children.length - 1}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

function StoryHeader({
  task,
  toggle,
  menu,
}: {
  task: TaskSummary;
  toggle: React.ReactNode;
  menu: React.ReactNode;
}) {
  const mine = task.is_self_assigned === 1;
  return (
    <Box
      sx={{
        px: 3,
        py: 3,
        display: "flex",
        alignItems: "center",
        gap: 2,
        transition: "background-color 80ms",
        "&:hover": { bg: "canvas.subtle" },
      }}
    >
      {toggle}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
          <PrimerLink
            as={Link}
            to={`/tasks/${task.id}`}
            sx={{
              fontWeight: 600,
              fontSize: 2,
              color: "fg.default",
              "&:hover": { color: "accent.fg" },
            }}
          >
            {task.title || `#${task.source_ref}`}
          </PrimerLink>
          <Text sx={{ color: "fg.subtle", fontSize: 0 }}>#{task.source_ref}</Text>
          {!mine && (
            <Label variant="default" size="small">grouping</Label>
          )}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 3 }}>
          <StateChip state={task.state} />
          <StatusBadge status={task.run_status} />
        </Box>
      </Box>
      {mine && (
        <Button
          leadingVisual={PlayIcon}
          variant="primary"
          size="small"
          disabled
          title="Tackle — wires up in M3"
        >
          Tackle
        </Button>
      )}
      {menu}
    </Box>
  );
}

function ChildRow({ task, last }: { task: TaskSummary; last: boolean }) {
  const mine = task.is_self_assigned === 1;
  return (
    <Box
      sx={{
        px: 3,
        py: 2,
        pl: "52px",
        display: "flex",
        alignItems: "center",
        gap: 2,
        borderBottomWidth: last ? 0 : 1,
        borderBottomStyle: "solid",
        borderBottomColor: "border.muted",
        transition: "background-color 80ms",
        "&:hover": { bg: "canvas.subtle" },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
          <PrimerLink
            as={Link}
            to={`/tasks/${task.id}`}
            sx={{
              fontWeight: 500,
              color: "fg.default",
              "&:hover": { color: "accent.fg" },
            }}
          >
            {task.title || `#${task.source_ref}`}
          </PrimerLink>
          <Text sx={{ color: "fg.subtle", fontSize: 0 }}>#{task.source_ref}</Text>
          {!mine && (
            <Label variant="default" size="small">grouping</Label>
          )}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 3 }}>
          <StateChip state={task.state} />
          <StatusBadge status={task.run_status} />
        </Box>
      </Box>
      {mine && (
        <Button
          leadingVisual={PlayIcon}
          variant="primary"
          size="small"
          disabled
          title="Tackle — wires up in M3"
        >
          Tackle
        </Button>
      )}
    </Box>
  );
}
