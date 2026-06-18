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
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <Box sx={{ mb: 1 }}>
        <Text sx={{ fontWeight: 600, fontSize: 2 }}>Run settings</Text>
        <Text sx={{ display: "block", color: "fg.muted", fontSize: 1, mt: 1 }}>
          Override the global defaults for this task.
        </Text>
      </Box>

      {error && (
        <Text sx={{ fontSize: 0, color: "danger.fg", mt: 2 }}>{error}</Text>
      )}

      <SettingRow
        label="Submit PR"
        caption={submitPr ? "runs end with opening a PR" : "runs end after review"}
        control={
          <ToggleSwitch
            checked={submitPr}
            onClick={() => {
              const next = !submitPr;
              setSubmitPr(next);
              void save({ submitPr: next });
            }}
            aria-label="Submit PR"
            size="small"
          />
        }
      />

      <SettingRow
        label="Worktree"
        caption={
          useWorktree
            ? "this run gets its own git worktree"
            : "this run uses the workspace directly — current branch, in place"
        }
        control={
          <ToggleSwitch
            checked={useWorktree}
            onClick={() => {
              const next = !useWorktree;
              setUseWorktree(next);
              void save({ useWorktree: next });
            }}
            aria-label="Use git worktree"
            size="small"
          />
        }
      />

      <SettingRow
        label="Base branch"
        caption="PR target and diff base. Leave blank to auto-detect from the remote default."
        control={
          <TextInput
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            onBlur={() => void save({ baseBranch })}
            placeholder="(auto)"
            sx={{ width: 220 }}
            monospace
          />
        }
      />

      <SettingRow
        label="Working branch"
        caption="An existing branch to work on. Leave blank to let Conveyer create a new one."
        control={
          <TextInput
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onBlur={() => void save({ branch })}
            placeholder="(new branch)"
            sx={{ width: 220 }}
            monospace
          />
        }
      />
    </Box>
  );
}

function SettingRow({
  label,
  caption,
  control,
}: {
  label: string;
  caption: string;
  control: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 3,
        py: 2,
        borderTopWidth: 1,
        borderTopStyle: "solid",
        borderTopColor: "border.subtle",
        "&:first-of-type": { borderTopWidth: 0 },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Text>
          {label}{" "}
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>· {caption}</Text>
        </Text>
      </Box>
      <Box sx={{ flexShrink: 0 }}>{control}</Box>
    </Box>
  );
}
