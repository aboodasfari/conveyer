import { useEffect, useId, useState } from "react";
import { Box, IconButton, Text, TextInput } from "@primer/react";
import { XIcon } from "@primer/octicons-react";
import { api } from "../api";
import { Workspace } from "../types";

/**
 * Workspace picker for the task detail page. Backed by a native
 * `<datalist>` so the input doubles as a dropdown of configured workspaces
 * *and* a freeform path entry — pick a known one or paste an absolute path.
 *
 * Empty value means "no explicit workspace" — the agent will be shown the
 * full list and asked to choose.
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
  const datalistId = useId();

  useEffect(() => { setDraft(value ?? ""); }, [value]);
  useEffect(() => {
    void api.workspacesList().then(setWorkspaces).catch(() => { /* ignore */ });
  }, []);

  const commit = async (next: string) => {
    const trimmed = next.trim();
    const normalized = trimmed || null;
    if (normalized === (value ?? null)) return;
    try {
      await api.taskSetWorkspace(taskId, normalized);
      onChange(normalized);
    } catch {
      setDraft(value ?? "");
    }
  };

  const matchedName = workspaces.find((w) => w.path === draft)?.name;

  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "border.muted",
        borderRadius: 2,
        p: 3,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Text sx={{ fontSize: 1, fontWeight: 600 }}>Workspace</Text>
        {draft && (
          <IconButton
            aria-label="Clear workspace"
            title="Clear (let the agent pick)"
            icon={XIcon}
            variant="invisible"
            size="small"
            onClick={() => { setDraft(""); void commit(""); }}
          />
        )}
      </Box>
      <Box>
        <TextInput
          block
          list={datalistId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Pick or paste a path…"
          aria-label="Workspace path"
        />
        <datalist id={datalistId}>
          {workspaces.map((w) => (
            <option key={w.id} value={w.path}>
              {w.name}
            </option>
          ))}
        </datalist>
      </Box>
      <Text sx={{ fontSize: 0, color: "fg.muted" }}>
        {draft
          ? matchedName
            ? <>Using <Box as="strong" sx={{ fontWeight: 600 }}>{matchedName}</Box>.</>
            : "Using a custom path."
          : "Not pinned — the agent will pick from the list."}
      </Text>
    </Box>
  );
}
