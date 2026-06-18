import { useEffect, useState } from "react";
import { Box, Spinner, Text, TextInput, ToggleSwitch } from "@primer/react";
import { api } from "../api";
import { Task } from "../types";
import { formatError } from "../errors";

/**
 * Shared resolver: returns the effective settings for a task (per-task value
 * if set, otherwise the global default). Used by both the side card and the
 * one-line summary so they always agree.
 */
async function loadEffective(taskId: string): Promise<{
  task: Task;
  useWorktree: boolean;
  submitPr: boolean;
  baseBranch: string;
  branch: string;
}> {
  const [task, gWt, gSub] = await Promise.all([
    api.taskGet(taskId),
    api.settingGet("use_worktree"),
    api.settingGet("phase_submit_enabled"),
  ]);
  const globalWt = gWt !== "0" && gWt?.toLowerCase() !== "false";
  const globalSub = gSub !== "0" && gSub?.toLowerCase() !== "false";
  return {
    task,
    useWorktree: task.use_worktree == null ? globalWt : task.use_worktree !== 0,
    submitPr: task.enable_submit == null ? globalSub : task.enable_submit !== 0,
    baseBranch: task.base_branch_override ?? "",
    branch: task.branch_override ?? "",
  };
}

/**
 * One-line, muted preview of what the run will do — sits under the Tackle
 * button so the user can sanity-check the resolved configuration without
 * scanning the side panel.
 */
export function TackleSummary({ taskId }: { taskId: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const e = await loadEffective(taskId);
        if (cancelled) return;
        const parts: string[] = [];
        parts.push(e.branch ? `on branch \`${e.branch}\`` : "on a new branch");
        parts.push(e.useWorktree ? "in a worktree" : "in the workspace");
        parts.push(e.baseBranch ? `targets \`${e.baseBranch}\`` : "targets default branch");
        parts.push(e.submitPr ? "opens a PR" : "no PR");
        setText(parts.join(" · "));
      } catch {
        if (!cancelled) setText(null);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  if (!text) return null;
  return (
    <Text sx={{ color: "fg.muted", fontSize: 0, maxWidth: 480 }}>{text}</Text>
  );
}

/**
 * Compact side card with the four per-task overrides. Toggles initialize
 * from the global default the first time the user sees the task, then
 * persist the concrete value on change. Text inputs persist on blur.
 */
export function TaskRunSettings({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);

  const [useWorktree, setUseWorktree] = useState<boolean>(true);
  const [submitPr, setSubmitPr] = useState<boolean>(true);
  const [baseBranch, setBaseBranch] = useState<string>("");
  const [branch, setBranch] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const e = await loadEffective(taskId);
        if (cancelled) return;
        setTask(e.task);
        setUseWorktree(e.useWorktree);
        setSubmitPr(e.submitPr);
        setBaseBranch(e.baseBranch);
        setBranch(e.branch);
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const save = async (next: {
    useWorktree?: boolean;
    submitPr?: boolean;
    baseBranch?: string;
    branch?: string;
  }) => {
    try {
      await api.taskOverridesSet(taskId, {
        useWorktree: next.useWorktree !== undefined ? next.useWorktree : useWorktree,
        enableSubmit: next.submitPr !== undefined ? next.submitPr : submitPr,
        baseBranchOverride:
          (next.baseBranch !== undefined ? next.baseBranch : baseBranch).trim() || null,
        branchOverride:
          (next.branch !== undefined ? next.branch : branch).trim() || null,
      });
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  };

  return (
    <Box
      sx={{
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        bg: "canvas.subtle",
        p: 3,
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <Text sx={{ fontWeight: 600, fontSize: 1 }}>Run settings</Text>

      {loading || !task ? (
        <Spinner size="small" />
      ) : (
        <>
          {error && <Text sx={{ fontSize: 0, color: "danger.fg" }}>{error}</Text>}

          <ToggleRow
            label="Submit PR"
            checked={submitPr}
            onChange={(v) => { setSubmitPr(v); void save({ submitPr: v }); }}
          />
          <ToggleRow
            label="Use worktree"
            checked={useWorktree}
            onChange={(v) => { setUseWorktree(v); void save({ useWorktree: v }); }}
          />

          <InputRow
            label="Base branch"
            value={baseBranch}
            onChange={setBaseBranch}
            onCommit={() => void save({ baseBranch })}
            placeholder="(auto)"
          />
          <InputRow
            label="Working branch"
            value={branch}
            onChange={setBranch}
            onCommit={() => void save({ branch })}
            placeholder="(new)"
          />
        </>
      )}
    </Box>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <Text sx={{ fontSize: 1 }}>{label}</Text>
      <ToggleSwitch
        checked={checked}
        onClick={() => onChange(!checked)}
        aria-label={label}
        size="small"
      />
    </Box>
  );
}

function InputRow({
  label,
  value,
  onChange,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  placeholder?: string;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Text sx={{ fontSize: 1 }}>{label}</Text>
      <TextInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        placeholder={placeholder}
        sx={{ width: "100%" }}
        monospace
      />
    </Box>
  );
}
