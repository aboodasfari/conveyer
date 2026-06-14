import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, IconButton, Text, TextInput } from "@primer/react";
import { CheckIcon, FileDirectoryIcon } from "@primer/octicons-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { Workspace } from "../types";

/**
 * Plain (form-style) workspace combobox: a TextInput backed by a popover
 * of configured workspaces with filter-as-you-type, plus a folder-picker
 * button. Unlike WorkspacePicker (the chip in the task header) this does
 * NOT persist anywhere — it's a controlled input for forms.
 */
export function WorkspaceCombobox({
  value,
  onChange,
  placeholder = "Pick a workspace or paste a path",
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const listId = useId();

  useEffect(() => {
    void api.workspacesList().then(setWorkspaces).catch(() => { /* noop */ });
  }, []);

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

  // Re-anchor the floating popover under the input on every open + scroll
  // + resize. position:fixed dodges any overflow:auto ancestor (modal body)
  // that would otherwise clip or scroll the dropdown into oblivion.
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter(
      (w) => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q),
    );
  }, [workspaces, value]);

  const pickFolder = async () => {
    try {
      const result = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose workspace",
        defaultPath: value || undefined,
      });
      if (typeof result === "string" && result) {
        onChange(result);
        setOpen(false);
      }
    } catch { /* cancelled */ }
  };

  return (
    <Box ref={containerRef} sx={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
        <TextInput
          ref={inputRef as React.Ref<HTMLInputElement>}
          block
          sx={{ flex: 1 }}
          autoFocus={autoFocus}
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlight(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => Math.min(filtered.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter") {
              if (open && filtered[highlight]) {
                e.preventDefault();
                onChange(filtered[highlight].path);
                setOpen(false);
              }
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          aria-controls={open ? listId : undefined}
          aria-expanded={open}
        />
        <IconButton
          aria-label="Browse for folder"
          title="Browse for folder"
          icon={FileDirectoryIcon}
          onClick={() => void pickFolder()}
        />
      </Box>
      {open && filtered.length > 0 && anchor && createPortal(
        <Box
          id={listId}
          role="listbox"
          onMouseDown={(e) => e.stopPropagation()}
          sx={{
            position: "fixed",
            top: anchor.top,
            left: anchor.left,
            width: anchor.width,
            maxHeight: 240,
            overflowY: "auto",
            bg: "canvas.overlay",
            border: "1px solid",
            borderColor: "border.default",
            borderRadius: 2,
            boxShadow: "shadow.large",
            zIndex: 1100,
            py: 1,
          }}
        >
          {filtered.map((w, i) => {
            const active = w.path === value;
            const highlighted = i === highlight;
            return (
              <Box
                key={w.id}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => { e.preventDefault(); onChange(w.path); setOpen(false); }}
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
        </Box>,
        document.body,
      )}
    </Box>
  );
}
