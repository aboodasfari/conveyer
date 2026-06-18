import { useEffect, useState } from "react";
import { Box, Spinner, Text, TextInput, ToggleSwitch } from "@primer/react";
import {
  CheckCircleFillIcon,
  CircleSlashIcon,
  GitBranchIcon,
  GitMergeIcon,
  PackageIcon,
  StackIcon,
} from "@primer/octicons-react";
import { api } from "../api";
import { Task } from "../types";
import { formatError } from "../errors";

interface Effective {
  task: Task;
  useWorktree: boolean;
  submitPr: boolean;
  baseBranch: string;
  branch: string;
}

/**
 * Shared resolver: returns the effective settings for a task (per-task value
 * if set, otherwise the global default). Used by both the side card and the
 * preview so they always agree.
 */
async function loadEffective(taskId: string): Promise<Effective> {
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

const PHASES: { kind: string; label: string }[] = [
  { kind: "exploration", label: "Exploration" },
  { kind: "planning", label: "Planning" },
  { kind: "implementation", label: "Implementation" },
  { kind: "review", label: "Review" },
  { kind: "submit", label: "Submit PR" },
];

/**
 * Visual preview of what the run will do — a structured fact list on the
 * left of the empty Run tab so the user can sanity-check the configuration
 * before clicking Tackle. Uses the same resolver as the side card so the
 * two always agree.
 */
export function RunPreview({ taskId }: { taskId: string }) {
  const [eff, setEff] = useState<Effective | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const e = await loadEffective(taskId);
        if (!cancelled) setEff(e);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  if (!eff) return null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, maxWidth: 520 }}>
      <Text sx={{ fontWeight: 600, fontSize: 1, color: "fg.muted" }}>
        This run will…
      </Text>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Fact
          icon={<GitBranchIcon size={14} />}
          label="Branch"
          value={eff.branch ? <code>{eff.branch}</code> : <em>create a new branch</em>}
          hint={eff.branch ? "existing" : "new"}
        />
        <Fact
          icon={<GitMergeIcon size={14} />}
          label="PR target"
          value={eff.baseBranch ? <code>{eff.baseBranch}</code> : <em>remote default branch</em>}
          hint={eff.baseBranch ? "custom" : "auto"}
        />
        <Fact
          icon={<PackageIcon size={14} />}
          label="Workdir"
          value={eff.useWorktree ? "isolated git worktree" : "the workspace itself"}
        />
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1, mt: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, color: "fg.muted" }}>
          <StackIcon size={14} />
          <Text sx={{ fontSize: 0, fontWeight: 600 }}>Phases</Text>
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, pl: 4 }}>
          {PHASES.map((p, i) => {
            const dimmed = p.kind === "submit" && !eff.submitPr;
            return (
              <Box key={p.kind} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                  sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 1,
                    px: 2,
                    py: 0,
                    fontSize: 0,
                    borderRadius: 999,
                    bg: dimmed ? "transparent" : "accent.subtle",
                    color: dimmed ? "fg.muted" : "accent.fg",
                    textDecoration: dimmed ? "line-through" : "none",
                    borderWidth: dimmed ? 1 : 0,
                    borderStyle: "solid",
                    borderColor: "border.default",
                  }}
                >
                  {dimmed ? <CircleSlashIcon size={10} /> : <CheckCircleFillIcon size={10} />}
                  <Text sx={{ fontSize: 0 }}>{p.label}</Text>
                </Box>
                {i < PHASES.length - 1 && (
                  <Text sx={{ color: "fg.muted", fontSize: 0 }}>›</Text>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

function Fact({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "baseline", gap: 2 }}>
      <Box sx={{ display: "inline-flex", color: "fg.muted", alignSelf: "center" }} aria-hidden>
        {icon}
      </Box>
      <Text sx={{ fontSize: 0, color: "fg.muted", fontWeight: 600, minWidth: 76 }}>
        {label}
      </Text>
      <Text sx={{ fontSize: 1 }}>{value}</Text>
      {hint && (
        <Text sx={{ fontSize: 0, color: "fg.muted" }}>· {hint}</Text>
      )}
    </Box>
  );
}

/**
 * Compact side card with the four per-task overrides. Fills the height of
 * its grid cell so the Run tab feels balanced. Toggles initialize from the
 * global default the first time the user sees the task, then persist the
 * concrete value on change.
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
        flex: 1,
        minHeight: 0,
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
            label="Working branch"
            hint="commits go here · leave blank to create new"
            value={branch}
            onChange={setBranch}
            onCommit={() => void save({ branch })}
            placeholder="(new)"
          />
          <InputRow
            label="Base branch"
            hint="PR target · leave blank for repo default"
            value={baseBranch}
            onChange={setBaseBranch}
            onCommit={() => void save({ baseBranch })}
            placeholder="(auto)"
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
  hint,
  value,
  onChange,
  onCommit,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  placeholder?: string;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Box sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 2 }}>
        <Text sx={{ fontSize: 1 }}>{label}</Text>
        {hint && (
          <Text sx={{ fontSize: 0, color: "fg.muted", textAlign: "right" }}>{hint}</Text>
        )}
      </Box>
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
