import { useMemo, useState } from "react";
import { Box, Button, Label, Link as PrimerLink, Text } from "@primer/react";
import { ChevronDownIcon, ChevronRightIcon, PlayIcon } from "@primer/octicons-react";
import { Link } from "react-router-dom";
import { TaskSummary } from "../types";
import { StatusBadge } from "./StatusBadge";

interface Node {
  task: TaskSummary;
  children: TaskSummary[];
}

/**
 * Builds a 2-level hierarchy:
 *   - Roots are tasks whose parent_ref is null or not present in our DB
 *   - Their children are tasks pointing at them via parent_ref
 *   - Orphans (children with a parent that disappeared) get promoted to roots
 */
export function TaskTree({ tasks }: { tasks: TaskSummary[] }) {
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
      .map((t) => ({
        task: t,
        children: childrenByParent.get(t.source_ref) ?? [],
      }));
  }, [tasks]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {nodes.map((n) => (
        <TreeRow key={n.task.id} node={n} />
      ))}
    </Box>
  );
}

function TreeRow({ node }: { node: Node }) {
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
      }}
    >
      <TaskRowInner
        task={node.task}
        toggleIcon={
          hasChildren ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-label={open ? "Collapse" : "Expand"}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                padding: 0,
                display: "inline-flex",
              }}
            >
              {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </button>
          ) : (
            <Box sx={{ width: 16 }} />
          )
        }
      />
      {hasChildren && open && (
        <Box
          sx={{
            borderTopWidth: 1,
            borderTopStyle: "solid",
            borderTopColor: "border.muted",
            bg: "canvas.subtle",
          }}
        >
          {node.children.map((c) => (
            <Box
              key={c.id}
              sx={{
                px: 3,
                py: 2,
                borderBottomWidth: 1,
                borderBottomStyle: "solid",
                borderBottomColor: "border.muted",
                "&:last-of-type": { borderBottomWidth: 0 },
              }}
            >
              <TaskRowInner task={c} indented />
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function TaskRowInner({
  task,
  toggleIcon,
  indented,
}: {
  task: TaskSummary;
  toggleIcon?: React.ReactNode;
  indented?: boolean;
}) {
  return (
    <Box
      sx={{
        p: indented ? 0 : 3,
        display: "flex",
        alignItems: "center",
        gap: 3,
      }}
    >
      {toggleIcon}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
          <PrimerLink
            as={Link}
            to={`/tasks/${task.id}`}
            sx={{ fontWeight: indented ? "normal" : "bold" }}
          >
            {task.title || `#${task.source_ref}`}
          </PrimerLink>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>#{task.source_ref}</Text>
          {task.is_self_assigned === 0 && (
            <Label variant="default" size="small">context</Label>
          )}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>{task.state}</Text>
          <StatusBadge status={task.run_status} />
        </Box>
      </Box>
      <Button
        leadingVisual={PlayIcon}
        variant="primary"
        size="small"
        disabled
        title={task.is_self_assigned === 0
          ? "Tackle whole story — coming in M3"
          : "Tackle — coming in M3"}
      >
        Tackle
      </Button>
    </Box>
  );
}
