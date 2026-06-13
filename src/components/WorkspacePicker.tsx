import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, Text, TextInput } from "@primer/react";
import { CheckIcon, ChevronDownIcon, FileDirectoryIcon, XIcon } from "@primer/octicons-react";
import { api } from "../api";
import { Workspace } from "../types";

/**
 * Workspace selector chip for the task title metadata row. Renders compactly
 * (folder icon + name or "No workspace") and opens a popover with a search
 * input + filtered list. Accepts freeform paths via Enter / blur. Empty
 * value means the agent picks at runtime from the full list.
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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(value ?? "");
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  useEffect(() => { setDraft(value ?? ""); }, [value]);
  useEffect(() => {
    void api.workspacesList().then(setWorkspaces).catch(() => { /* noop */ });
  }, []);

  // Reset draft + focus input each time the popover opens.
  useEffect(() => {
    if (open) {
      setDraft(value ?? "");
      setHighlight(0);
      // Focus on next tick so the input is rendered.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, value]);

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

  const matchedName = value ? workspaces.find((w) => w.path === value)?.name : null;
  const triggerLabel = value
    ? (matchedName ?? value.split("/").filter(Boolean).slice(-1)[0] ?? value)
    : "No workspace";

  return (
    <Box ref={containerRef} sx={{ position: "relative" }}>
      <Box
        as="button"
        type="button"
        onClick={() => setOpen((o) => !o)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1,
          bg: open ? "neutral.muted" : "transparent",
          border: "1px solid",
          borderColor: "border.muted",
          borderRadius: 2,
          color: value ? "fg.default" : "fg.muted",
          fontSize: 0,
          cursor: "pointer",
          "&:hover": { bg: "neutral.subtle" },
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value ?? "Pick a workspace for this task"}
      >
        <FileDirectoryIcon size={12} />
        <Text sx={{ fontSize: 0, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {triggerLabel}
        </Text>
        <ChevronDownIcon size={12} />
      </Box>

      {open && (
        <Box
          sx={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            width: 360,
            bg: "canvas.overlay",
            border: "1px solid",
            borderColor: "border.default",
            borderRadius: 2,
            boxShadow: "shadow.large",
            zIndex: 50,
            p: 2,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <TextInput
            ref={inputRef as React.Ref<HTMLInputElement>}
            block
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setHighlight(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => Math.min(filtered.length - 1, h + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(0, h - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (filtered[highlight]) {
                  void commit(filtered[highlight].path);
                } else {
                  void commit(draft);
                }
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Search or paste a path…"
            aria-label="Workspace path"
            aria-controls={listId}
            trailingAction={
              value ? (
                <TextInput.Action
                  onClick={() => { setDraft(""); void commit(""); }}
                  icon={XIcon}
                  aria-label="Clear workspace"
                  sx={{ color: "fg.muted" }}
                />
              ) : undefined
            }
          />
          <Box id={listId} role="listbox" sx={{ maxHeight: 240, overflowY: "auto", mx: -2, mb: -2, borderTop: "1px solid", borderTopColor: "border.muted" }}>
            {filtered.length === 0 ? (
              <Text sx={{ display: "block", color: "fg.muted", fontSize: 0, p: 2 }}>
                {workspaces.length === 0
                  ? "No workspaces configured. Add some in Settings, or paste a freeform path above."
                  : "No matches. Press Enter to use what you typed as a freeform path."}
              </Text>
            ) : (
              filtered.map((w, i) => {
                const active = w.path === value;
                const highlighted = i === highlight;
                return (
                  <Box
                    key={w.id}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => { e.preventDefault(); void commit(w.path); }}
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
              })
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
