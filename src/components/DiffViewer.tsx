import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Flash, Spinner, Text } from "@primer/react";
import { ChevronDownIcon, ChevronRightIcon, FileIcon } from "@primer/octicons-react";
import { api } from "../api";
import { DiffSummary } from "../types";
import { formatError } from "../errors";

/**
 * Diff viewer for the implementation/review/submit phases. Shows the diff
 * between the run's recorded base commit and the worktree HEAD, with a left
 * rail listing each individual commit so the user can also inspect a single
 * commit in isolation.
 */
export function DiffViewer({ phaseId }: { phaseId: string }) {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [diffText, setDiffText] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null); // null = overall
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.phaseDiffSummary(phaseId);
      setSummary(s);
    } catch (e) {
      setError(formatError(e));
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [phaseId]);

  const loadDiff = useCallback(async (commit: string | null) => {
    setLoadingDiff(true);
    try {
      const text = await api.phaseDiffText(phaseId, commit);
      setDiffText(text);
    } catch (e) {
      setError(formatError(e));
      setDiffText("");
    } finally {
      setLoadingDiff(false);
    }
  }, [phaseId]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { void loadDiff(selected); }, [selected, loadDiff]);

  const files = useMemo(() => parseDiff(diffText), [diffText]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <Spinner size="small" />
      </Box>
    );
  }
  if (error || !summary) {
    return (
      <Flash variant="warning">{error ?? "No diff available yet."}</Flash>
    );
  }

  const noChanges = summary.head_sha === summary.base_sha && summary.commits.length === 0;

  return (
    <Box sx={{ display: "flex", gap: 0, height: "100%", minHeight: 0 }}>
      {/* Left rail: commit selector */}
      <Box
        sx={{
          width: 240,
          flexShrink: 0,
          borderRight: "1px solid",
          borderRightColor: "border.muted",
          overflowY: "auto",
          pr: 2,
        }}
      >
        <Box sx={{ mb: 2 }}>
          <Text sx={{ fontSize: 0, color: "fg.muted", display: "block" }}>
            Branch
          </Text>
          <Text sx={{ fontFamily: "mono", fontSize: 0, display: "block", wordBreak: "break-all" }}>
            {summary.branch || "(detached)"}
          </Text>
        </Box>
        <CommitRow
          label="Overall"
          subtitle={`${summary.commits.length} commit${summary.commits.length === 1 ? "" : "s"}`}
          active={selected === null}
          onSelect={() => setSelected(null)}
        />
        {summary.commits.map((c) => (
          <CommitRow
            key={c.sha}
            label={c.subject || c.short_sha}
            subtitle={`${c.short_sha} · ${c.author}`}
            active={selected === c.sha}
            onSelect={() => setSelected(c.sha)}
          />
        ))}
      </Box>

      {/* Right pane: file diffs */}
      <Box sx={{ flex: 1, overflowY: "auto", pl: 3, minWidth: 0 }}>
        {loadingDiff ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <Spinner size="small" />
          </Box>
        ) : noChanges ? (
          <Text sx={{ color: "fg.muted" }}>
            No commits yet. The agent should commit logically split changes on this branch.
          </Text>
        ) : files.length === 0 ? (
          <Text sx={{ color: "fg.muted" }}>No file changes in this view.</Text>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {files.map((f, i) => (
              <FileDiff key={i} file={f} />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function CommitRow({
  label,
  subtitle,
  active,
  onSelect,
}: {
  label: string;
  subtitle: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <Box
      onClick={onSelect}
      sx={{
        py: 2,
        px: 2,
        borderRadius: 1,
        cursor: "pointer",
        bg: active ? "accent.subtle" : "transparent",
        borderLeftWidth: 3,
        borderLeftStyle: "solid",
        borderLeftColor: active ? "accent.fg" : "transparent",
        "&:hover": { bg: active ? "accent.subtle" : "canvas.subtle" },
      }}
    >
      <Text sx={{ display: "block", fontWeight: active ? 600 : 400, fontSize: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </Text>
      <Text sx={{ display: "block", color: "fg.muted", fontSize: 0, fontFamily: "mono" }}>
        {subtitle}
      </Text>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Diff parsing                                */
/* -------------------------------------------------------------------------- */

interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "renamed" | "modified" | "binary";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}
interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
interface DiffLine {
  kind: "context" | "add" | "del";
  oldNo?: number;
  newNo?: number;
  text: string;
}

/**
 * Parse unified diff output (`git diff --patch-with-stat` / `git show`).
 * Skips the diffstat preamble and any commit metadata, splits into file
 * sections by `diff --git`, then parses hunks.
 */
function parseDiff(text: string): DiffFile[] {
  if (!text) return [];
  const files: DiffFile[] = [];
  const parts = text.split(/(?=^diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith("diff --git ")) continue;
    const file = parseFileSection(part);
    if (file) files.push(file);
  }
  return files;
}

function parseFileSection(section: string): DiffFile | null {
  const lines = section.split("\n");
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let status: DiffFile["status"] = "modified";
  let i = 0;

  // Header lines (before the first hunk).
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("@@ ")) break;
    if (ln.startsWith("--- a/")) oldPath = ln.slice(6);
    else if (ln.startsWith("--- /dev/null")) { status = "added"; oldPath = undefined; }
    else if (ln.startsWith("+++ b/")) newPath = ln.slice(6);
    else if (ln.startsWith("+++ /dev/null")) { status = "deleted"; newPath = undefined; }
    else if (ln.startsWith("new file mode")) status = "added";
    else if (ln.startsWith("deleted file mode")) status = "deleted";
    else if (ln.startsWith("rename from ")) { oldPath = ln.slice(12); status = "renamed"; }
    else if (ln.startsWith("rename to ")) { newPath = ln.slice(10); status = "renamed"; }
    else if (ln.startsWith("Binary files")) status = "binary";
  }

  // Fall back to parsing the diff --git line if neither --- / +++ appeared.
  if (!oldPath && !newPath) {
    const m = section.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (m) { oldPath = m[1]; newPath = m[2]; }
  }

  const hunks: DiffHunk[] = [];
  let additions = 0, deletions = 0;
  let cur: DiffHunk | null = null;
  let oldNo = 0, newNo = 0;

  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("@@ ")) {
      const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) continue;
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[2], 10);
      cur = { header: ln, oldStart: oldNo, newStart: newNo, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (ln.startsWith("+") && !ln.startsWith("+++ ")) {
      additions++;
      cur.lines.push({ kind: "add", newNo: newNo++, text: ln.slice(1) });
    } else if (ln.startsWith("-") && !ln.startsWith("--- ")) {
      deletions++;
      cur.lines.push({ kind: "del", oldNo: oldNo++, text: ln.slice(1) });
    } else if (ln.startsWith(" ")) {
      cur.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: ln.slice(1) });
    } else if (ln.startsWith("\\")) {
      // "\ No newline at end of file" — ignore
    }
  }

  const path = newPath || oldPath || "(unknown)";
  return {
    path,
    oldPath: status === "renamed" ? oldPath : undefined,
    status,
    hunks,
    additions,
    deletions,
  };
}

/* -------------------------------------------------------------------------- */
/*                              File rendering                                */
/* -------------------------------------------------------------------------- */

function FileDiff({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  const statusBg = STATUS_BG[file.status];
  return (
    <Box sx={{ border: "1px solid", borderColor: "border.muted", borderRadius: 2 }}>
      <Box
        onClick={() => setOpen((o) => !o)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          px: 2,
          py: 2,
          bg: "canvas.subtle",
          cursor: "pointer",
          borderBottom: open ? "1px solid" : "none",
          borderBottomColor: "border.muted",
        }}
      >
        <Box sx={{ color: "fg.muted" }}>
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </Box>
        <FileIcon size={14} />
        <Text sx={{ fontFamily: "mono", fontSize: 1, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        </Text>
        <Text
          sx={{
            fontSize: 0,
            color: "fg.muted",
            bg: statusBg,
            px: 2,
            py: 0,
            borderRadius: 1,
            textTransform: "capitalize",
          }}
        >
          {file.status}
        </Text>
        {(file.additions > 0 || file.deletions > 0) && (
          <Text sx={{ fontFamily: "mono", fontSize: 0 }}>
            <Box as="span" sx={{ color: "success.fg" }}>+{file.additions}</Box>
            {" "}
            <Box as="span" sx={{ color: "danger.fg" }}>-{file.deletions}</Box>
          </Text>
        )}
      </Box>
      {open && (
        <Box sx={{ overflowX: "auto", fontFamily: "mono", fontSize: 0 }}>
          {file.hunks.length === 0 ? (
            <Text sx={{ color: "fg.muted", px: 2, py: 2, display: "block" }}>
              {file.status === "binary" ? "Binary file." : "No textual changes."}
            </Text>
          ) : (
            file.hunks.map((h, i) => <Hunk key={i} hunk={h} />)
          )}
        </Box>
      )}
    </Box>
  );
}

const STATUS_BG: Record<DiffFile["status"], string> = {
  added: "success.subtle",
  deleted: "danger.subtle",
  renamed: "attention.subtle",
  modified: "neutral.subtle",
  binary: "neutral.subtle",
};

function Hunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <Box>
      <Box
        sx={{
          px: 2, py: 1,
          color: "fg.muted",
          bg: "canvas.inset",
          borderTop: "1px solid",
          borderTopColor: "border.muted",
          borderBottom: "1px solid",
          borderBottomColor: "border.muted",
        }}
      >
        {hunk.header}
      </Box>
      {hunk.lines.map((l, i) => (
        <DiffLineRow key={i} line={l} />
      ))}
    </Box>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const bg = line.kind === "add" ? "success.subtle"
    : line.kind === "del" ? "danger.subtle"
    : "transparent";
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  return (
    <Box sx={{ display: "flex", bg, "&:hover": { bg: line.kind === "context" ? "canvas.subtle" : bg } }}>
      <Box sx={{ width: 40, textAlign: "right", pr: 1, color: "fg.muted", userSelect: "none", flexShrink: 0 }}>
        {line.oldNo ?? ""}
      </Box>
      <Box sx={{ width: 40, textAlign: "right", pr: 2, color: "fg.muted", userSelect: "none", flexShrink: 0 }}>
        {line.newNo ?? ""}
      </Box>
      <Box sx={{ width: 16, color: "fg.muted", userSelect: "none", flexShrink: 0 }}>{marker}</Box>
      <Box sx={{ flex: 1, whiteSpace: "pre", color: "fg.default" }}>{line.text || " "}</Box>
    </Box>
  );
}
