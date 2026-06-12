import { useMemo, useState, MouseEvent } from "react";
import {
  ActionList,
  ActionMenu,
  Box,
  Button,
  IconButton,
  Text,
} from "@primer/react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  KebabHorizontalIcon,
  PlayIcon,
} from "@primer/octicons-react";
import { useNavigate } from "react-router-dom";
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

/** Work-item states where there is nothing for Conveyer to do. */
const TERMINAL_STATES = new Set(
  ["done", "closed", "resolved", "completed", "removed"],
);
const isActionable = (t: TaskSummary) =>
  t.is_self_assigned === 1 && !TERMINAL_STATES.has(t.state.toLowerCase().trim());

/** Stop a click inside an interactive control from triggering the parent card link. */
const stop = (e: MouseEvent) => e.stopPropagation();

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
  // If any child is yours, hide the parent's Tackle button — the user
  // tackles individual tasks rather than the whole story in that case.
  const someChildMine = node.children.some((c) => c.is_self_assigned === 1);
  const showStoryTackle = isActionable(node.task) && !someChildMine;

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
        showTackle={showStoryTackle}
        toggle={hasChildren ? (
          <IconButton
            aria-label={open ? "Collapse" : "Expand"}
            icon={open ? ChevronDownIcon : ChevronRightIcon}
            variant="invisible"
            size="small"
            onClick={(e) => { stop(e); setOpen((o) => !o); }}
          />
        ) : (
          <Box sx={{ width: 28 }} />
        )}
        menu={onMove ? (
          <Box onClick={stop}>
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
          </Box>
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
  showTackle,
  toggle,
  menu,
}: {
  task: TaskSummary;
  showTackle: boolean;
  toggle: React.ReactNode;
  menu: React.ReactNode;
}) {
  const nav = useNavigate();
  return (
    <Box
      onClick={() => nav(`/tasks/${task.id}`)}
      sx={{
        px: 3,
        py: 3,
        display: "flex",
        alignItems: "center",
        gap: 2,
        cursor: "pointer",
        transition: "background-color 80ms",
        "&:hover": { bg: "canvas.subtle" },
      }}
    >
      {toggle}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
          <Text
            sx={{
              fontWeight: 600,
              fontSize: 2,
              color: "fg.default",
            }}
          >
            {task.title || `#${task.source_ref}`}
          </Text>
          <Text sx={{ color: "fg.subtle", fontSize: 0 }}>#{task.source_ref}</Text>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 3 }}>
          <StateChip state={task.state} />
          <StatusBadge status={task.run_status} />
        </Box>
      </Box>
      {showTackle && (
        <Button
          leadingVisual={PlayIcon}
          variant="primary"
          size="small"
          disabled
          onClick={stop}
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
  const nav = useNavigate();
  return (
    <Box
      onClick={() => nav(`/tasks/${task.id}`)}
      sx={{
        px: 3,
        py: 2,
        pl: "52px",
        display: "flex",
        alignItems: "center",
        gap: 2,
        cursor: "pointer",
        borderBottomWidth: last ? 0 : 1,
        borderBottomStyle: "solid",
        borderBottomColor: "border.muted",
        transition: "background-color 80ms",
        "&:hover": { bg: "canvas.subtle" },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
          <Text
            sx={{
              fontWeight: 500,
              color: "fg.default",
            }}
          >
            {task.title || `#${task.source_ref}`}
          </Text>
          <Text sx={{ color: "fg.subtle", fontSize: 0 }}>#{task.source_ref}</Text>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 3 }}>
          <StateChip state={task.state} />
          <StatusBadge status={task.run_status} />
        </Box>
      </Box>
      {isActionable(task) && (
        <Button
          leadingVisual={PlayIcon}
          variant="primary"
          size="small"
          disabled
          onClick={stop}
          title="Tackle — wires up in M3"
        >
          Tackle
        </Button>
      )}
    </Box>
  );
}
