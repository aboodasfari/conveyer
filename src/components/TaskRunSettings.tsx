import { useEffect, useMemo, useState } from "react";
import { Box, Button, Flash, Spinner, Text, TextInput, ToggleSwitch } from "@primer/react";
import {
  ChecklistIcon,
  CodeIcon,
  EyeIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  PackageIcon,
  PlayIcon,
  SearchIcon,
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

const PHASES: { kind: string; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { kind: "exploration", label: "Exploration", icon: SearchIcon },
  { kind: "planning", label: "Planning", icon: ChecklistIcon },
  { kind: "implementation", label: "Implementation", icon: CodeIcon },
  { kind: "review", label: "Review", icon: EyeIcon },
  { kind: "submit", label: "Submit PR", icon: GitPullRequestIcon },
];

/**
 * The empty-run view of the Run tab. Owns the resolved-settings state for
 * the task so the left-side preview and the right-side settings card stay
 * in sync as the user toggles things. Two columns:
 *
 *   left  → Tackle CTA + structured RunPreview
 *   right → TaskRunSettings card (full-height side panel)
 */
export function EmptyRunView({
  taskId,
  onStart,
  busy,
  error,
}: {
  taskId: string;
  onStart: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [eff, setEff] = useState<Effective | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [task, gWt, gSub] = await Promise.all([
          api.taskGet(taskId),
          api.settingGet("use_worktree"),
          api.settingGet("phase_submit_enabled"),
        ]);
        if (cancelled) return;
        const globalWt = gWt !== "0" && gWt?.toLowerCase() !== "false";
        const globalSub = gSub !== "0" && gSub?.toLowerCase() !== "false";
        setEff({
          task,
          useWorktree: task.use_worktree == null ? globalWt : task.use_worktree !== 0,
          submitPr: task.enable_submit == null ? globalSub : task.enable_submit !== 0,
          baseBranch: task.base_branch_override ?? "",
          branch: task.branch_override ?? "",
        });
      } catch (e) {
        if (!cancelled) setLoadError(formatError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  // Apply a partial update locally first (so the preview reflects it
  // instantly), then persist. Caller passes only the changed field(s).
  const update = async (patch: Partial<Omit<Effective, "task">>) => {
    if (!eff) return;
    const merged: Effective = { ...eff, ...patch };
    setEff(merged);
    try {
      await api.taskOverridesSet(taskId, {
        useWorktree: merged.useWorktree,
        enableSubmit: merged.submitPr,
        baseBranchOverride: merged.baseBranch.trim() || null,
        branchOverride: merged.branch.trim() || null,
      });
    } catch (e) {
      setLoadError(formatError(e));
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        height: "calc(100vh - 300px)",
        minHeight: 440,
      }}
    >
      {error && <Flash variant="danger">{error}</Flash>}
      {loadError && <Flash variant="danger">{loadError}</Flash>}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "1fr 340px",
          gap: 4,
          alignItems: "stretch",
          flex: 1,
          minHeight: 0,
        }}
      >
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignItems: "flex-start",
            minWidth: 0,
            pt: 1,
          }}
        >
          <Button
            leadingVisual={PlayIcon}
            variant="primary"
            size="large"
            onClick={onStart}
            disabled={busy}
          >
            {busy ? "Starting…" : "Tackle this task"}
          </Button>
          <RunPreview eff={eff} />
        </Box>
        <RunSettingsCard eff={eff} update={update} />
      </Box>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Run preview                                 */
/* -------------------------------------------------------------------------- */

function RunPreview({ eff }: { eff: Effective | null }) {
  const phases = useMemo(() => {
    if (!eff) return null;
    return PHASES.filter((p) => p.kind !== "submit" || eff.submitPr);
  }, [eff]);

  if (!eff || !phases) return null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, maxWidth: 560, minWidth: 0 }}>
      <Text sx={{ fontWeight: 600, fontSize: 1, color: "fg.muted" }}>
        This run will…
      </Text>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Fact
          icon={<GitBranchIcon size={14} />}
          label="Branch"
          value={eff.branch ? <code>{eff.branch}</code> : "create a new branch"}
        />
        <Fact
          icon={<GitMergeIcon size={14} />}
          label="PR target"
          value={
            eff.submitPr
              ? eff.baseBranch
                ? <code>{eff.baseBranch}</code>
                : "the repo's default branch"
              : <Text sx={{ color: "fg.muted" }}>not opening a PR</Text>
          }
        />
        <Fact
          icon={<PackageIcon size={14} />}
          label="Workdir"
          value={eff.useWorktree ? "isolated git worktree" : "the workspace, in place"}
        />
      </Box>

      <Box sx={{ mt: 2 }}>
        <Text sx={{ fontSize: 0, fontWeight: 600, color: "fg.muted", display: "block", mb: 2 }}>
          Pipeline
        </Text>
        <PhaseStepper phases={phases} />
      </Box>
    </Box>
  );
}

/** Horizontal stepper: numbered circles with phase icons + labels beneath,
 *  connected by thin lines. Calm but visually structured. */
function PhaseStepper({
  phases,
}: {
  phases: { kind: string; label: string; icon: React.ComponentType<{ size?: number }> }[];
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        // Wider gap on bigger screens; collapses gracefully.
        flexWrap: "wrap",
        rowGap: 3,
      }}
    >
      {phases.map((p, i) => {
        const Icon = p.icon;
        const isLast = i === phases.length - 1;
        return (
          <Box
            key={p.kind}
            sx={{
              display: "flex",
              alignItems: "flex-start",
              flex: isLast ? "0 0 auto" : "1 1 0",
              minWidth: 80,
            }}
          >
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 1,
                minWidth: 80,
              }}
            >
              <Box
                sx={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  bg: "canvas.subtle",
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: "border.default",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "accent.fg",
                }}
              >
                <Icon size={16} />
              </Box>
              <Text
                sx={{
                  fontSize: 0,
                  color: "fg.default",
                  textAlign: "center",
                  lineHeight: 1.3,
                }}
              >
                {p.label}
              </Text>
            </Box>
            {!isLast && (
              <Box
                aria-hidden
                sx={{
                  flex: 1,
                  height: 1,
                  bg: "border.default",
                  mt: "18px",
                  mx: 1,
                  minWidth: 16,
                }}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function Fact({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
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
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Run settings (side card)                        */
/* -------------------------------------------------------------------------- */

function RunSettingsCard({
  eff,
  update,
}: {
  eff: Effective | null;
  update: (patch: Partial<Omit<Effective, "task">>) => void;
}) {
  // Local mirror for the text inputs so typing doesn't trigger a save on
  // every keystroke; commits to the parent on blur.
  const [branch, setBranch] = useState<string>(eff?.branch ?? "");
  const [baseBranch, setBaseBranch] = useState<string>(eff?.baseBranch ?? "");

  useEffect(() => {
    setBranch(eff?.branch ?? "");
    setBaseBranch(eff?.baseBranch ?? "");
  }, [eff?.branch, eff?.baseBranch]);

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

      {!eff ? (
        <Spinner size="small" />
      ) : (
        <>
          <ToggleRow
            label="Submit PR"
            checked={eff.submitPr}
            onChange={(v) => update({ submitPr: v })}
          />
          <ToggleRow
            label="Use worktree"
            checked={eff.useWorktree}
            onChange={(v) => update({ useWorktree: v })}
          />
          <InputRow
            label="Working branch"
            value={branch}
            onChange={setBranch}
            onCommit={() => update({ branch })}
            placeholder="(new)"
          />
          <InputRow
            label="Target branch"
            value={baseBranch}
            onChange={setBaseBranch}
            onCommit={() => update({ baseBranch })}
            placeholder="(auto)"
            disabled={!eff.submitPr && !!eff.branch.trim()}
            disabledReason="No PR is being opened from an existing branch — nothing to target."
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
  disabled,
  disabledReason,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Text sx={{ fontSize: 1, color: disabled ? "fg.muted" : "fg.default" }}>{label}</Text>
      <TextInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        placeholder={placeholder}
        disabled={disabled}
        sx={{ width: "100%" }}
        monospace
      />
      {disabled && disabledReason && (
        <Text sx={{ fontSize: 0, color: "fg.muted" }}>{disabledReason}</Text>
      )}
    </Box>
  );
}
