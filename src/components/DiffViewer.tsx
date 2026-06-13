import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionList, ActionMenu, Box, Flash, IconButton, Spinner, Text } from "@primer/react";
import {
  CheckIcon,
  CopyIcon,
  DiffAddedIcon,
  DiffModifiedIcon,
  DiffRemovedIcon,
  DiffRenamedIcon,
  FileBinaryIcon,
  GitCommitIcon,
} from "@primer/octicons-react";
import { api } from "../api";
import { DiffSummary } from "../types";
import { formatError } from "../errors";

const LEFT_PANE_DEFAULT = 260;
const LEFT_PANE_MIN = 180;
const LEFT_PANE_MAX = 520;

/**
 * Diff viewer for the implementation/review/submit phases. Top header has the
 * branch/worktree + commit selector; below is a resizable two-pane split:
 * left = file list (status icon + path + ± counts), right = the selected
 * file's diff. Click a file to focus it; drag the divider to resize.
 */
export function DiffViewer({ phaseId }: { phaseId: string }) {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [diffText, setDiffText] = useState<string>("");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null); // null = overall
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [leftWidth, setLeftWidth] = useState<number>(LEFT_PANE_DEFAULT);

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
  useEffect(() => { void loadDiff(selectedCommit); }, [selectedCommit, loadDiff]);

  const files = useMemo(() => parseDiff(diffText), [diffText]);

  // When the file list changes (commit switch, new load), auto-select the
  // first file if the current selection isn't present.
  useEffect(() => {
    if (files.length === 0) {
      setSelectedFile(null);
      return;
    }
    if (!selectedFile || !files.some((f) => f.path === selectedFile)) {
      setSelectedFile(files[0].path);
    }
  }, [files, selectedFile]);

  const activeFile = useMemo(
    () => files.find((f) => f.path === selectedFile) ?? null,
    [files, selectedFile],
  );

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <Spinner size="small" />
      </Box>
    );
  }
  if (error) {
    return <Flash variant="danger">{error}</Flash>;
  }
  if (!summary) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, py: 6, color: "fg.muted" }}>
        <Text sx={{ fontSize: 1 }}>No worktree yet.</Text>
        <Text sx={{ fontSize: 0 }}>
          The Diff tab populates once the implementation phase starts.
        </Text>
      </Box>
    );
  }

  const noCommits = summary.commits.length === 0;
  const activeCommit = selectedCommit
    ? summary.commits.find((c) => c.sha === selectedCommit) ?? null
    : null;
  const commitLabel = activeCommit
    ? `${activeCommit.short_sha} · ${activeCommit.subject}`
    : `Overall (${summary.commits.length} commit${summary.commits.length === 1 ? "" : "s"})`;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 2 }}>
      {/* Header: branch + worktree + open + commit selector */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "baseline", gap: 2, minWidth: 0 }}>
          <Text sx={{ fontSize: 0, color: "fg.muted" }}>Branch</Text>
          <Text sx={{ fontFamily: "mono", fontSize: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {summary.branch || "(detached)"}
          </Text>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, flex: 1 }}>
          <Text sx={{ fontSize: 0, color: "fg.muted" }}>Worktree</Text>
          <Text
            sx={{
              fontFamily: "mono",
              fontSize: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              color: "fg.default",
            }}
            title={summary.worktree_path}
          >
            {summary.worktree_path}
          </Text>
          <CopyPathButton path={summary.worktree_path} />
        </Box>
        <ActionMenu>
          <ActionMenu.Button leadingVisual={GitCommitIcon} size="small" disabled={noCommits}>
            {commitLabel}
          </ActionMenu.Button>
          <ActionMenu.Overlay width="xlarge">
            <ActionList selectionVariant="single">
              <ActionList.Item selected={selectedCommit === null} onSelect={() => setSelectedCommit(null)}>
                Overall
                <ActionList.Description variant="block">
                  {summary.commits.length} commit{summary.commits.length === 1 ? "" : "s"}
                </ActionList.Description>
              </ActionList.Item>
              {summary.commits.length > 0 && <ActionList.Divider />}
              {summary.commits.map((c) => (
                <ActionList.Item
                  key={c.sha}
                  selected={selectedCommit === c.sha}
                  onSelect={() => setSelectedCommit(c.sha)}
                >
                  {c.subject || c.short_sha}
                  <ActionList.Description variant="block">
                    {c.short_sha} · {c.author}
                  </ActionList.Description>
                </ActionList.Item>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </Box>

      {/* Resizable split */}
      {loadingDiff ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <Spinner size="small" />
        </Box>
      ) : noCommits && files.length === 0 ? (
        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, py: 4, color: "fg.muted" }}>
          <Text>No commits yet.</Text>
          <Text sx={{ fontSize: 0 }}>The agent will commit logically split changes on this branch.</Text>
        </Box>
      ) : files.length === 0 ? (
        <Text sx={{ color: "fg.muted" }}>No file changes in this view.</Text>
      ) : (
        <SplitPane
          leftWidth={leftWidth}
          setLeftWidth={setLeftWidth}
          left={
            <FileList
              files={files}
              selected={selectedFile}
              onSelect={setSelectedFile}
            />
          }
          right={
            activeFile ? (
              <FileDiff file={activeFile} />
            ) : (
              <Text sx={{ color: "fg.muted" }}>Select a file to view its diff.</Text>
            )
          }
        />
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Resizable split                               */
/* -------------------------------------------------------------------------- */

function SplitPane({
  leftWidth,
  setLeftWidth,
  left,
  right,
}: {
  leftWidth: number;
  setLeftWidth: (w: number) => void;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = Math.max(LEFT_PANE_MIN, Math.min(LEFT_PANE_MAX, e.clientX - rect.left));
      setLeftWidth(w);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setLeftWidth]);

  return (
    <Box
      ref={containerRef}
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        border: "1px solid",
        borderColor: "border.muted",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <Box sx={{ width: leftWidth, flexShrink: 0, overflowY: "auto" }}>
        {left}
      </Box>
      <Box
        onMouseDown={onMouseDown}
        sx={{
          width: 4,
          flexShrink: 0,
          cursor: "col-resize",
          bg: "border.muted",
          "&:hover": { bg: "accent.fg" },
          transition: "background-color 80ms",
        }}
        aria-label="Resize file list"
        role="separator"
      />
      <Box sx={{ flex: 1, minWidth: 0, overflowY: "auto", overflowX: "auto" }}>
        {right}
      </Box>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 File list                                  */
/* -------------------------------------------------------------------------- */

function FileList({
  files,
  selected,
  onSelect,
}: {
  files: DiffFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <Box sx={{ py: 1 }}>
      {files.map((f) => {
        const Icon = STATUS_ICON[f.status];
        const iconColor = STATUS_ICON_COLOR[f.status];
        const active = f.path === selected;
        return (
          <Box
            key={f.path}
            onClick={() => onSelect(f.path)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              px: 2,
              py: 1,
              cursor: "pointer",
              bg: active ? "accent.subtle" : "transparent",
              borderLeftWidth: 3,
              borderLeftStyle: "solid",
              borderLeftColor: active ? "accent.fg" : "transparent",
              "&:hover": { bg: active ? "accent.subtle" : "canvas.subtle" },
            }}
            title={f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path}
          >
            <Box sx={{ color: iconColor, flexShrink: 0, display: "flex" }}>
              <Icon size={14} />
            </Box>
            <Text
              sx={{
                fontFamily: "mono",
                fontSize: 0,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                direction: "rtl", // ellipsise from the start of the path
                textAlign: "left",
              }}
            >
              {f.path}
            </Text>
            <Text sx={{ fontFamily: "mono", fontSize: 0, flexShrink: 0 }}>
              <ChangeCounts additions={f.additions} deletions={f.deletions} />
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

const STATUS_ICON: Record<DiffFile["status"], React.ComponentType<{ size?: number }>> = {
  added: DiffAddedIcon,
  deleted: DiffRemovedIcon,
  renamed: DiffRenamedIcon,
  modified: DiffModifiedIcon,
  binary: FileBinaryIcon,
};

const STATUS_ICON_COLOR: Record<DiffFile["status"], string> = {
  added: "success.fg",
  deleted: "danger.fg",
  renamed: "attention.fg",
  modified: "accent.fg",
  binary: "fg.muted",
};

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
  const statusBg = STATUS_BG[file.status];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          px: 2,
          py: 2,
          bg: "canvas.subtle",
          borderBottom: "1px solid",
          borderBottomColor: "border.muted",
          flexShrink: 0,
        }}
      >
        <Text sx={{ fontFamily: "mono", fontSize: 1, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
      <Box sx={{ flex: 1, minHeight: 0, overflowX: "auto", overflowY: "auto", fontFamily: "mono", fontSize: 0 }}>
        {file.hunks.length === 0 ? (
          <Text sx={{ color: "fg.muted", px: 2, py: 2, display: "block" }}>
            {file.status === "binary" ? "Binary file." : "No textual changes."}
          </Text>
        ) : (
          // Wrapper grows with the widest line so coloured row backgrounds
          // extend the full content width when the user scrolls horizontally.
          <Box sx={{ minWidth: "max-content" }}>
            {file.hunks.map((h, i) => <Hunk key={i} hunk={h} />)}
          </Box>
        )}
      </Box>
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
  // Compute the last new-file line number this hunk covers, so we can show
  // a friendly "Lines N–M" range instead of the raw `@@ -..,.. +..,.. @@` line.
  const lastNewNo = (() => {
    for (let i = hunk.lines.length - 1; i >= 0; i--) {
      const ln = hunk.lines[i].newNo;
      if (typeof ln === "number") return ln;
    }
    return hunk.newStart;
  })();
  const label = lastNewNo > hunk.newStart
    ? `Lines ${hunk.newStart}–${lastNewNo}`
    : `Line ${hunk.newStart}`;
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
          fontSize: 0,
        }}
      >
        {label}
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
      <Box sx={{ flex: 1, whiteSpace: "pre", color: "fg.default", pr: 2 }}>{line.text || " "}</Box>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/** Render +/- counts, omitting either if its value is zero. */
function ChangeCounts({ additions, deletions }: { additions: number; deletions: number }) {
  const parts: React.ReactNode[] = [];
  if (additions > 0) {
    parts.push(
      <Box key="add" as="span" sx={{ color: "success.fg" }}>+{additions}</Box>,
    );
  }
  if (deletions > 0) {
    parts.push(
      <Box key="del" as="span" sx={{ color: "danger.fg" }}>-{deletions}</Box>,
    );
  }
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " "}
          {p}
        </span>
      ))}
    </>
  );
}

/** Copies the given path to the clipboard; shows a brief check confirmation. */
function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail under restricted contexts — silently ignore.
    }
  }, [path]);
  return (
    <IconButton
      aria-label="Copy worktree path"
      title={copied ? "Copied!" : "Copy worktree path"}
      icon={copied ? CheckIcon : CopyIcon}
      variant="invisible"
      size="small"
      onClick={onClick}
    />
  );
}
