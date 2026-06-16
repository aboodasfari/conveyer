import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionList, ActionMenu, Box, Button, Flash, IconButton, SegmentedControl, Spinner, Text } from "@primer/react";
import {
  CheckIcon,
  ColumnsIcon,
  CommentIcon,
  CopyIcon,
  DiffAddedIcon,
  DiffIcon,
  DiffModifiedIcon,
  DiffRemovedIcon,
  DiffRenamedIcon,
  FileBinaryIcon,
  GitCommitIcon,
  PlusIcon,
} from "@primer/octicons-react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { Comment, DiffSummary } from "../types";
import { formatError } from "../errors";
import { TabPlaceholder } from "./TabPlaceholder";
import { CommentCard, CommentComposer } from "./CommentThread";

const LEFT_PANE_DEFAULT = 260;
const LEFT_PANE_MIN = 180;
const LEFT_PANE_MAX = 520;

/**
 * Diff viewer for the implementation/review/submit phases. Top header has the
 * branch/worktree + commit selector; below is a resizable two-pane split:
 * left = file list (status icon + path + ± counts), right = the selected
 * file's diff. Click a file to focus it; drag the divider to resize.
 */
export function DiffViewer({ phaseId, phaseStatus }: { phaseId: string; phaseStatus?: string }) {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [diffText, setDiffText] = useState<string>("");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null); // null = overall
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [leftWidth, setLeftWidth] = useState<number>(LEFT_PANE_DEFAULT);
  const [viewMode, setViewMode] = useState<"inline" | "split">("inline");

  // Review comments. Only usable while the phase is gated (waiting).
  const canComment = phaseStatus === "waiting";
  const [commentMode, setCommentMode] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  // Active inline composer anchor, or null.
  const [composeAt, setComposeAt] = useState<{
    file: string; line: number; side: string; snippet: string;
  } | null>(null);

  const loadComments = useCallback(async () => {
    try {
      setComments(await api.commentsForPhase(phaseId));
    } catch {
      // non-fatal
    }
  }, [phaseId]);

  const loadSummary = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const s = await api.phaseDiffSummary(phaseId);
      setSummary(s);
    } catch (e) {
      setError(formatError(e));
      setSummary(null);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [phaseId]);

  const loadDiff = useCallback(async (commit: string | null, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadingDiff(true);
    try {
      const text = await api.phaseDiffText(phaseId, commit);
      setDiffText(text);
    } catch (e) {
      setError(formatError(e));
      setDiffText("");
    } finally {
      if (!opts?.silent) setLoadingDiff(false);
    }
  }, [phaseId]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { void loadDiff(selectedCommit); }, [selectedCommit, loadDiff]);
  useEffect(() => { void loadComments(); }, [loadComments]);

  // Comment mode no longer forces inline — SBS supports comments too.
  useEffect(() => {
    if (!canComment) { setCommentMode(false); setComposeAt(null); }
  }, [canComment]);

  // Reload comments when the processor changes them.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen<{ phase_id?: string }>("comments_changed", (e) => {
        if (!e.payload?.phase_id || e.payload.phase_id === phaseId) void loadComments();
      });
      if (cancelled) unlisten();
    })();
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, [phaseId, loadComments]);

  // Light poll so newly-made commits appear without waiting for the next
  // phase transition. Silent: doesn't flash the loading spinner.
  useEffect(() => {
    const id = window.setInterval(() => {
      void loadSummary({ silent: true });
      void loadDiff(selectedCommit, { silent: true });
    }, 3000);
    return () => window.clearInterval(id);
  }, [loadSummary, loadDiff, selectedCommit]);

  // Re-fetch when anything about this run changes (worktree created,
  // agent committed, phase advanced) so the Diff tab stays live without
  // a manual refresh. Also silent — the visible content barely shifts.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void (async () => {
      unlisten = await listen("run_updated", () => {
        void loadSummary({ silent: true });
        void loadDiff(selectedCommit, { silent: true });
      });
      if (cancelled) unlisten();
    })();
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, [loadSummary, loadDiff, selectedCommit]);

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
      <TabPlaceholder
        title="Code diffs will show up here once the implementation phase starts."
      />
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
      {/* Header: commit selector + view mode toggle */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          flexShrink: 0,
        }}
      >
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
        <Box sx={{ flex: 1 }} />
        {canComment && (
          <Button
            size="small"
            leadingVisual={CommentIcon}
            variant={commentMode ? "primary" : "default"}
            onClick={() => setCommentMode((v) => !v)}
          >
            {commentMode ? "Commenting" : "Comment"}
            {comments.length > 0 ? ` · ${commentRollup(comments)}` : ""}
          </Button>
        )}
        <SegmentedControl aria-label="Diff view mode" size="small">
          <SegmentedControl.IconButton
            icon={DiffIcon}
            aria-label="Inline view"
            selected={viewMode === "inline"}
            onClick={() => setViewMode("inline")}
          />
          <SegmentedControl.IconButton
            icon={ColumnsIcon}
            aria-label="Side-by-side view"
            selected={viewMode === "split"}
            onClick={() => setViewMode("split")}
          />
        </SegmentedControl>
      </Box>

      {/* Resizable split */}
      {loadingDiff ? (
        <Spinner size="small" />
      ) : noCommits && files.length === 0 ? (
        <TabPlaceholder
          title="No commits yet."
          subtitle="The agent's commits will show up here as they happen."
        />
      ) : files.length === 0 ? (
        <TabPlaceholder title="No file changes in this view." />
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
              <FileDiff
                file={activeFile}
                mode={viewMode}
                phaseId={phaseId}
                commentMode={commentMode}
                comments={comments.filter((c) => c.file_path === activeFile.path)}
                composeAt={composeAt && composeAt.file === activeFile.path ? composeAt : null}
                onStartCompose={(line, side, snippet) =>
                  setComposeAt({ file: activeFile.path, line, side, snippet })
                }
                onCancelCompose={() => setComposeAt(null)}
              />
            ) : (
              <Text sx={{ color: "fg.muted" }}>Select a file to view its diff.</Text>
            )
          }
        />
      )}

      {/* Footer: branch + worktree path + copy */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          flexShrink: 0,
          borderTop: "1px solid",
          borderTopColor: "border.muted",
          pt: 1,
          color: "fg.muted",
          fontSize: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
          <Text>Branch</Text>
          <Text sx={{ fontFamily: "mono", color: "fg.default" }}>
            {summary.branch || "(detached)"}
          </Text>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, flex: 1 }}>
          <Text sx={{ flexShrink: 0 }}>Worktree</Text>
          <Text
            sx={{
              fontFamily: "mono",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              color: "fg.default",
              direction: "rtl",
              textAlign: "left",
            }}
            title={summary.worktree_path}
          >
            {summary.worktree_path}
          </Text>
          <CopyPathButton path={summary.worktree_path} />
        </Box>
      </Box>
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

interface CommentProps {
  phaseId: string;
  commentMode: boolean;
  comments: Comment[];
  composeAt: { file: string; line: number; side: string; snippet: string } | null;
  onStartCompose: (line: number, side: string, snippet: string) => void;
  onCancelCompose: () => void;
}

function FileDiff({
  file,
  mode,
  phaseId,
  commentMode,
  comments,
  composeAt,
  onStartCompose,
  onCancelCompose,
}: { file: DiffFile; mode: "inline" | "split" } & CommentProps) {
  const statusBg = STATUS_BG[file.status];
  const cp: CommentProps = { phaseId, commentMode, comments, composeAt, onStartCompose, onCancelCompose };
  // With full-context diffs (-U99999) the common case is a single hunk
  // starting at line 1, which is just "the whole file" — don't bother
  // showing a hunk header for that.
  const hideHunkHeaders = file.hunks.length === 1 && file.hunks[0].newStart === 1;
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
        <Text sx={{ fontFamily: "mono", fontSize: 0 }}>
          <ChangeCounts additions={file.additions} deletions={file.deletions} />
        </Text>
      </Box>
      {file.hunks.length === 0 ? (
        <Box sx={{ flex: 1, minHeight: 0, fontFamily: "mono", fontSize: 0 }}>
          <Text sx={{ color: "fg.muted", px: 2, py: 2, display: "block" }}>
            {file.status === "binary" ? "Binary file." : "No textual changes."}
          </Text>
        </Box>
      ) : mode === "split" ? (
        <SideBySideFile file={file} hideHunkHeaders={hideHunkHeaders} cp={cp} />
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, overflowX: "auto", overflowY: "auto", fontFamily: "mono", fontSize: 0 }}>
          <Box sx={{ minWidth: "max-content" }}>
            {file.hunks.map((h, i) => (
              <Hunk key={i} hunk={h} hideHeader={hideHunkHeaders} cp={cp} />
            ))}
          </Box>
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

function Hunk({ hunk, hideHeader, cp }: { hunk: DiffHunk; hideHeader?: boolean; cp?: CommentProps }) {
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
      {!hideHeader && (
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
      )}
      {hunk.lines.map((l, i) => {
        const anchor = lineAnchor(l);
        const lineComments = cp && anchor
          ? cp.comments.filter((c) => c.side === anchor.side && c.line_start === anchor.no)
          : [];
        const composing =
          cp?.composeAt != null &&
          anchor != null &&
          cp.composeAt.side === anchor.side &&
          cp.composeAt.line === anchor.no;
        return (
          <Box key={i}>
            <DiffLineRow
              line={l}
              commentMode={cp?.commentMode ?? false}
              highlighted={lineComments.length > 0 || composing}
              onAdd={
                cp && anchor
                  ? () => cp.onStartCompose(anchor.no, anchor.side, l.text)
                  : undefined
              }
            />
            {lineComments.map((c) => (
              <CommentCard key={c.id} comment={c} />
            ))}
            {composing && cp && (
              <CommentComposer
                phaseId={cp.phaseId}
                filePath={cp.composeAt!.file}
                lineStart={cp.composeAt!.line}
                lineEnd={cp.composeAt!.line}
                side={cp.composeAt!.side}
                snippet={cp.composeAt!.snippet}
                onDone={cp.onCancelCompose}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** The anchor (line number + side) a comment attaches to for a diff line. */
function lineAnchor(line: DiffLine): { no: number; side: string } | null {
  if (line.kind === "del") {
    return typeof line.oldNo === "number" ? { no: line.oldNo, side: "old" } : null;
  }
  const no = line.newNo ?? line.oldNo;
  return typeof no === "number" ? { no, side: "new" } : null;
}

/* -------------------------------------------------------------------------- */
/*                         Side-by-side file rendering                        */
/* -------------------------------------------------------------------------- */

interface PairedLine {
  kind: "context" | "add" | "del" | "empty";
  oldNo?: number;
  newNo?: number;
  text: string;
}

/** Walk the file's hunks and produce two parallel arrays of lines, one for
 * each side of the SBS view, padded with "empty" entries so the two columns
 * stay row-aligned. */
function buildSidePairs(file: DiffFile): { left: PairedLine[]; right: PairedLine[]; hunkSeparators: Set<number> } {
  const left: PairedLine[] = [];
  const right: PairedLine[] = [];
  const hunkSeparators = new Set<number>();
  let firstHunk = true;
  for (const hunk of file.hunks) {
    if (!firstHunk) {
      // Mark this row as a hunk separator so the renderer can draw a divider.
      hunkSeparators.add(left.length);
      left.push({ kind: "empty", text: "" });
      right.push({ kind: "empty", text: "" });
    }
    firstHunk = false;

    let i = 0;
    while (i < hunk.lines.length) {
      const ln = hunk.lines[i];
      if (ln.kind === "context") {
        left.push({ kind: "context", oldNo: ln.oldNo, text: ln.text });
        right.push({ kind: "context", newNo: ln.newNo, text: ln.text });
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      while (i < hunk.lines.length && hunk.lines[i].kind === "del") {
        dels.push(hunk.lines[i]); i++;
      }
      const adds: DiffLine[] = [];
      while (i < hunk.lines.length && hunk.lines[i].kind === "add") {
        adds.push(hunk.lines[i]); i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const d = dels[k];
        const a = adds[k];
        left.push(d
          ? { kind: "del", oldNo: d.oldNo, text: d.text }
          : { kind: "empty", text: "" });
        right.push(a
          ? { kind: "add", newNo: a.newNo, text: a.text }
          : { kind: "empty", text: "" });
      }
    }
  }
  return { left, right, hunkSeparators };
}

const SBS_LEFT_DEFAULT_PCT = 0.5;

function SideBySideFile({
  file,
  hideHunkHeaders,
  cp,
}: {
  file: DiffFile;
  hideHunkHeaders: boolean;
  cp?: CommentProps;
}) {
  const { left, right, hunkSeparators } = useMemo(() => buildSidePairs(file), [file]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [leftFrac, setLeftFrac] = useState<number>(SBS_LEFT_DEFAULT_PCT);

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
      if (!rect || rect.width === 0) return;
      const frac = (e.clientX - rect.left) / rect.width;
      setLeftFrac(Math.max(0.15, Math.min(0.85, frac)));
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
  }, []);

  const header = !hideHunkHeaders && file.hunks.length > 0
    ? hunkHeaderLabel(file.hunks[0])
    : null;

  // One vertical scroll container of rows; each diff row holds both cells
  // so left/right stay aligned, and comment cards drop in as full-width
  // rows between diff rows without breaking alignment.
  return (
    <Box ref={containerRef} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      {header && (
        <Box sx={{ px: 2, py: 1, color: "fg.muted", bg: "canvas.subtle", borderBottom: "1px solid", borderBottomColor: "border.muted", fontSize: 0, fontFamily: "mono", flexShrink: 0 }}>
          {header}
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", fontFamily: "mono", fontSize: 0, position: "relative" }}>
        {/* Continuous draggable divider overlay at the split fraction. */}
        <Box
          onMouseDown={onMouseDown}
          role="separator"
          aria-label="Resize side-by-side"
          sx={{
            position: "absolute",
            top: 0, bottom: 0,
            left: `calc(${leftFrac * 100}% - 2px)`,
            width: 4,
            cursor: "col-resize",
            bg: "border.muted",
            "&:hover": { bg: "accent.fg" },
            transition: "background-color 80ms",
            zIndex: 2,
          }}
        />
        {left.map((l, i) => {
          const r = right[i];
          const sep = hunkSeparators.has(i);
          const anchor = sbsAnchor(l, r);
          const lineComments = cp && anchor
            ? cp.comments.filter((c) => c.side === anchor.side && c.line_start === anchor.no)
            : [];
          const composing =
            cp?.composeAt != null && anchor != null &&
            cp.composeAt.side === anchor.side && cp.composeAt.line === anchor.no;
          const highlighted = lineComments.length > 0 || composing;
          return (
            <Box key={i}>
              <Box sx={{ display: "flex", minWidth: "100%", ...(highlighted ? { boxShadow: "inset 3px 0 0 var(--bgColor-accent-emphasis, #4493f8)" } : {}) }}>
                <Box sx={{ width: `${leftFrac * 100}%`, flexShrink: 0, overflowX: "auto" }}>
                  <SideCell
                    line={l}
                    side="left"
                    separator={sep}
                    commentMode={cp?.commentMode ?? false}
                    onAdd={cp && l.kind === "del" && typeof l.oldNo === "number"
                      ? () => cp.onStartCompose(l.oldNo!, "old", l.text)
                      : undefined}
                  />
                </Box>
                <Box sx={{ flex: 1, minWidth: 0, overflowX: "auto" }}>
                  <SideCell
                    line={r}
                    side="right"
                    separator={sep}
                    commentMode={cp?.commentMode ?? false}
                    onAdd={cp && (r.kind === "add" || r.kind === "context") && typeof r.newNo === "number"
                      ? () => cp.onStartCompose(r.newNo!, "new", r.text)
                      : undefined}
                  />
                </Box>
              </Box>
              {lineComments.map((c) => (
                <CommentCard key={c.id} comment={c} />
              ))}
              {composing && cp && (
                <CommentComposer
                  phaseId={cp.phaseId}
                  filePath={cp.composeAt!.file}
                  lineStart={cp.composeAt!.line}
                  lineEnd={cp.composeAt!.line}
                  side={cp.composeAt!.side}
                  snippet={cp.composeAt!.snippet}
                  onDone={cp.onCancelCompose}
                />
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** Which line a comment anchors to in SBS: prefer the new (right) side. */
function sbsAnchor(left: PairedLine, right: PairedLine): { no: number; side: string } | null {
  if (right.kind !== "empty" && typeof right.newNo === "number") {
    return { no: right.newNo, side: "new" };
  }
  if (left.kind === "del" && typeof left.oldNo === "number") {
    return { no: left.oldNo, side: "old" };
  }
  if (typeof right.newNo === "number") return { no: right.newNo, side: "new" };
  return null;
}

function SideCell({
  line,
  side,
  separator,
  commentMode,
  onAdd,
}: {
  line: PairedLine;
  side: "left" | "right";
  separator: boolean;
  commentMode?: boolean;
  onAdd?: () => void;
}) {
  if (line.kind === "empty") {
    return (
      <Box
        sx={{
          display: "flex",
          minWidth: "max-content",
          bg: "canvas.subtle",
          backgroundImage: "repeating-linear-gradient(45deg, transparent 0 6px, var(--bgColor-muted, rgba(128,128,128,0.08)) 6px 7px)",
          borderTop: separator ? "1px solid" : "none",
          borderTopColor: "border.muted",
        }}
      >
        <Box sx={{ width: 40, flexShrink: 0 }} />
        <Box sx={{ pr: 2 }}>&nbsp;</Box>
      </Box>
    );
  }
  const bg = line.kind === "add" ? "success.subtle"
    : line.kind === "del" ? "danger.subtle"
    : "transparent";
  const lineNo = side === "left" ? line.oldNo : line.newNo;
  return (
    <Box
      sx={{
        display: "flex",
        minWidth: "max-content",
        bg,
        position: "relative",
        borderTop: separator ? "1px solid" : "none",
        borderTopColor: "border.muted",
        "&:hover": { bg: line.kind === "context" ? "canvas.subtle" : bg },
        "&:hover .conveyer-add-comment": { opacity: 1 },
      }}
    >
      {commentMode && onAdd && (
        <Box
          className="conveyer-add-comment"
          role="button"
          aria-label="Add comment on this line"
          onClick={onAdd}
          sx={{
            position: "absolute", left: "2px", top: "1px",
            width: 16, height: 16, borderRadius: 1,
            bg: "accent.emphasis", color: "fg.onEmphasis",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", opacity: 0, transition: "opacity 80ms", zIndex: 1,
          }}
        >
          <PlusIcon size={12} />
        </Box>
      )}
      <Box sx={{ width: 40, textAlign: "right", pr: 1, color: "fg.muted", userSelect: "none", flexShrink: 0 }}>
        {lineNo ?? ""}
      </Box>
      <Box sx={{ flex: 1, whiteSpace: "pre", color: "fg.default", pl: 1, pr: 2 }}>
        {line.text || " "}
      </Box>
    </Box>
  );
}

function hunkHeaderLabel(hunk: DiffHunk): string {
  let lastNewNo = hunk.newStart;
  for (let i = hunk.lines.length - 1; i >= 0; i--) {
    const ln = hunk.lines[i].newNo;
    if (typeof ln === "number") { lastNewNo = ln; break; }
  }
  return lastNewNo > hunk.newStart
    ? `Lines ${hunk.newStart}–${lastNewNo}`
    : `Line ${hunk.newStart}`;
}

function DiffLineRow({
  line,
  commentMode,
  highlighted,
  onAdd,
}: {
  line: DiffLine;
  commentMode?: boolean;
  highlighted?: boolean;
  onAdd?: () => void;
}) {
  const bg = line.kind === "add" ? "success.subtle"
    : line.kind === "del" ? "danger.subtle"
    : "transparent";
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  // One line-number column referring to the new file. Deletion lines
  // don't exist in the new file, so leave the column blank for them.
  const lineNo = line.kind === "del" ? undefined : (line.newNo ?? line.oldNo);
  return (
    <Box
      sx={{
        display: "flex",
        bg,
        position: "relative",
        ...(highlighted
          ? {
              boxShadow: "inset 3px 0 0 var(--bgColor-accent-emphasis, #4493f8)",
              bg: "attention.subtle",
            }
          : {}),
        "&:hover": { bg: line.kind === "context" ? "canvas.subtle" : bg },
        "&:hover .conveyer-add-comment": { opacity: 1 },
      }}
    >
      {commentMode && onAdd && (
        <Box
          className="conveyer-add-comment"
          role="button"
          aria-label="Add comment on this line"
          onClick={onAdd}
          sx={{
            position: "absolute",
            left: "2px",
            top: "1px",
            width: 16,
            height: 16,
            borderRadius: 1,
            bg: "accent.emphasis",
            color: "fg.onEmphasis",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            opacity: 0,
            transition: "opacity 80ms",
            zIndex: 1,
          }}
        >
          <PlusIcon size={12} />
        </Box>
      )}
      <Box sx={{ width: 48, textAlign: "right", pr: 2, color: "fg.muted", userSelect: "none", flexShrink: 0 }}>
        {lineNo ?? ""}
      </Box>
      <Box sx={{ width: 16, color: "fg.muted", userSelect: "none", flexShrink: 0 }}>{marker}</Box>
      <Box sx={{ flex: 1, whiteSpace: "pre", color: "fg.default", pr: 2 }}>{line.text || " "}</Box>
    </Box>
  );
}

/** Short rollup like "2 working · 1 open" for the header button. */
function commentRollup(comments: Comment[]): string {
  const open = comments.filter((c) => c.status === "queued").length;
  const working = comments.filter((c) => c.status === "working").length;
  const addressed = comments.filter((c) => c.status === "addressed").length;
  const parts: string[] = [];
  if (working > 0) parts.push(`${working} working`);
  if (open > 0) parts.push(`${open} queued`);
  if (addressed > 0) parts.push(`${addressed} to review`);
  return parts.length > 0 ? parts.join(" · ") : `${comments.length}`;
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
