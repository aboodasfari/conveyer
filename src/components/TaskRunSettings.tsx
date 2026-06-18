import { useEffect, useState } from "react";
import { Box, Spinner, Text, TextInput, ToggleSwitch } from "@primer/react";
import { api } from "../api";
import { Task } from "../types";
import { formatError } from "../errors";

/**
 * Per-task overrides for the four run knobs (worktree, base branch, working
 * branch, submit PR). Mirrors the Settings → Run Defaults layout so the two
 * surfaces feel like the same UI.
 *
 * Toggles are initialized from the global default when the task has no
 * explicit value, then persist as concrete 0/1 once the user touches them —
 * no "Inherit" tri-state. Text inputs persist on blur; empty trims to NULL,
 * which means "fall back to auto-detect / generate".
 *
 * Lives in the Run tab above the Tackle button so it can be set before the
 * first run.
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
        const [t, gWt, gSub] = await Promise.all([
          api.taskGet(taskId),
          api.settingGet("use_worktree"),
          api.settingGet("phase_submit_enabled"),
        ]);
        if (cancelled) return;
        setTask(t);
        const globalWt = gWt !== "0" && gWt?.toLowerCase() !== "false";
        const globalSub = gSub !== "0" && gSub?.toLowerCase() !== "false";
        setUseWorktree(t?.use_worktree == null ? globalWt : t.use_worktree !== 0);
        setSubmitPr(t?.enable_submit == null ? globalSub : t.enable_submit !== 0);
        setBaseBranch(t?.base_branch_override ?? "");
        setBranch(t?.branch_override ?? "");
      } catch (e) {
        if (!cancelled) setError(formatError(e));
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
    const merged = {
      useWorktree: next.useWorktree !== undefined ? next.useWorktree : useWorktree,
      enableSubmit: next.submitPr !== undefined ? next.submitPr : submitPr,
      baseBranchOverride: (next.baseBranch !== undefined ? next.baseBranch : baseBranch)
        .trim() || null,
      branchOverride: (next.branch !== undefined ? next.branch : branch)
        .trim() || null,
    };
    try {
      await api.taskOverridesSet(taskId, merged);
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  };

  if (loading || !task) {
    return <Spinner size="small" />;
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Box>
        <Text sx={{ fontWeight: 600, fontSize: 2 }}>Run settings</Text>
        <Text sx={{ display: "block", color: "fg.muted", fontSize: 1, mt: 1 }}>
          Override the global defaults for this task.
        </Text>
      </Box>

      {error && (
        <Text sx={{ fontSize: 0, color: "danger.fg" }}>{error}</Text>
      )}

      <ToggleSetting
        label="Submit PR"
        caption={submitPr ? "Runs end with opening a PR." : "Runs end after review — no PR is opened."}
        checked={submitPr}
        onChange={(v) => {
          setSubmitPr(v);
          void save({ submitPr: v });
        }}
      />

      <ToggleSetting
        label="Worktree"
        caption={
          useWorktree
            ? "This run gets its own git worktree, so the agent can commit freely without disturbing your checkout."
            : "This run uses the workspace directly — current branch, in place. No worktree is created."
        }
        checked={useWorktree}
        onChange={(v) => {
          setUseWorktree(v);
          void save({ useWorktree: v });
        }}
      />

      <InputSetting
        label="Base branch"
        caption="PR target and diff base. Leave blank to auto-detect from the remote default."
        value={baseBranch}
        onChange={setBaseBranch}
        onCommit={() => void save({ baseBranch })}
        placeholder="(auto)"
      />

      <InputSetting
        label="Working branch"
        caption="An existing branch to work on instead of creating a new one. Leave blank to let Conveyer create `<alias>/<slug>`."
        value={branch}
        onChange={setBranch}
        onCommit={() => void save({ branch })}
        placeholder="(new branch)"
      />
    </Box>
  );
}

/** Inline toggle row: label + switch on one line, caption beneath. */
function ToggleSetting({
  label,
  caption,
  checked,
  onChange,
}: {
  label: string;
  caption: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 3 }}>
        <Text sx={{ fontWeight: 600 }}>{label}</Text>
        <ToggleSwitch
          checked={checked}
          onClick={() => onChange(!checked)}
          aria-label={label}
          size="small"
        />
      </Box>
      <Text sx={{ display: "block", color: "fg.muted", fontSize: 0, mt: 1, maxWidth: 560 }}>
        {caption}
      </Text>
    </Box>
  );
}

/** Stacked text-input row: label, caption, then full-width input beneath. */
function InputSetting({
  label,
  caption,
  value,
  onChange,
  onCommit,
  placeholder,
}: {
  label: string;
  caption: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  placeholder?: string;
}) {
  return (
    <Box>
      <Text sx={{ fontWeight: 600, display: "block" }}>{label}</Text>
      <Text sx={{ display: "block", color: "fg.muted", fontSize: 0, mt: 1, maxWidth: 560 }}>
        {caption}
      </Text>
      <TextInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        placeholder={placeholder}
        sx={{ mt: 2, width: 320 }}
        monospace
      />
    </Box>
  );
}
