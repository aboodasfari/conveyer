import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, IconButton, Text, TextInput } from "@primer/react";
import { CheckIcon, ChevronDownIcon, XIcon } from "@primer/octicons-react";
import { api } from "../api";
import { Workspace } from "../types";

/**
 * Workspace picker for the task detail page. A clean text input with an
 * inline dropdown of configured workspaces that filters as you type.
 * Anything typed is accepted as a freeform path — Enter or blur commits.
 * Empty value means "no explicit workspace" and the agent picks from the
 * full list at runtime.
 */
export function WorkspacePicker({
  taskId,
  value,
  onChange,
}: {
  taskId: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [draft, setDraft] = useState<string>(value ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  useEffect(() => { setDraft(value ?? ""); }, [value]);
  useEffect(() => {
    void api.workspacesList().then(setWorkspaces).catch(() => { /* noop */ });
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter(
      (w) => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q),
    );
  }, [workspaces, draft]);

  const commit = useCallback(async (next: string) => {
    const trimmed = next.trim();
    const normalized = trimmed || null;
    setOpen(false);
    if (normalized === (value ?? null)) return;
    try {
      await api.taskSetWorkspace(taskId, normalized);
      onChange(normalized);
    } catch {
      setDraft(value ?? "");
    }
  }, [taskId, value, onChange]);

  const select = (path: string) => {
    setDraft(path);
    void commit(path);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && filtered[highlight]) {
        select(filtered[highlight].path);
      } else {
        void commit(draft);
      }
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const matchedName = workspaces.find((w) => w.path === draft)?.name;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Text sx={{ fontSize: 0, color: "fg.muted", fontWeight: 600 }}>WORKSPACE</Text>

      <Box ref={containerRef} sx={{ position: "relative" }}>
        <TextInput
          block
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setOpen(true); setHighlight(0); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Agent picks from the list"
          aria-label="Workspace path"
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-expanded={open}
          trailingAction={
            draft ? (
              <TextInput.Action
                onClick={() => { setDraft(""); void commit(""); }}
                icon={XIcon}
                aria-label="Clear workspace"
                sx={{ color: "fg.muted" }}
              />
            ) : (
              <TextInput.Action
                onClick={() => setOpen((o) => !o)}
                icon={ChevronDownIcon}
                aria-label="Show workspaces"
                sx={{ color: "fg.muted" }}
              />
            )
          }
        />
        {open && filtered.length > 0 && (
          <Box
            id={listId}
            role="listbox"
            sx={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              maxHeight: 240,
              overflowY: "auto",
              bg: "canvas.overlay",
              border: "1px solid",
              borderColor: "border.default",
              borderRadius: 2,
              boxShadow: "shadow.large",
              zIndex: 50,
              py: 1,
            }}
          >
            {filtered.map((w, i) => {
              const active = w.path === draft;
              const highlighted = i === highlight;
              return (
                <Box
                  key={w.id}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => { e.preventDefault(); select(w.path); }}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                    px: 2,
                    py: 1,
                    cursor: "pointer",
                    bg: highlighted ? "neutral.subtle" : "transparent",
                  }}
                >
                  <Box sx={{ width: 14, color: "accent.fg", flexShrink: 0 }}>
                    {active && <CheckIcon size={14} />}
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Text sx={{ display: "block", fontSize: 1, fontWeight: 600 }}>
                      {w.name}
                    </Text>
                    <Text
                      sx={{
                        display: "block",
                        fontSize: 0,
                        color: "fg.muted",
                        fontFamily: "mono",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {w.path}
                    </Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      <Text sx={{ fontSize: 0, color: "fg.muted" }}>
        {draft
          ? matchedName
            ? <>Using <Box as="strong" sx={{ fontWeight: 600 }}>{matchedName}</Box>.</>
            : "Using a custom path."
          : "The agent will pick from the list at runtime."}
      </Text>
    </Box>
  );
}

// Avoid TS error about unused IconButton import if we don't use it elsewhere.
void IconButton;
