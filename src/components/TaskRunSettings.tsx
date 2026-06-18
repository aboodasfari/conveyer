import { useEffect, useMemo, useState } from "react";
import { Box, Button, Flash, Spinner, Text, TextInput, ToggleSwitch } from "@primer/react";
import {
  GitBranchIcon,
  GitMergeIcon,
  PackageIcon,
  PlayIcon,
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

const PHASES: { kind: string; label: string; color: string }[] = [
  { kind: "exploration", label: "Exploration", color: "#f0883e" },     // orange — discovery
  { kind: "planning", label: "Planning", color: "#1f6feb" },           // blue — structured
  { kind: "implementation", label: "Implementation", color: "#8957e5" }, // purple — build
  { kind: "review", label: "Review", color: "#3fb950" },               // green — verify
  { kind: "submit", label: "Submit PR", color: "#db61a2" },            // pink — action
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

  // Apply a partial update. When opts.persist is false (default true), the
  // change is reflected in local state only — used by text inputs so the
  // preview reacts on every keystroke while we save on blur.
  const update = async (
    patch: Partial<Omit<Effective, "task">>,
    opts: { persist?: boolean } = {},
  ) => {
    if (!eff) return;
    const merged: Effective = { ...eff, ...patch };
    setEff(merged);
    if (opts.persist === false) return;
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
            minWidth: 0,
            pt: 1,
          }}
        >
          <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <RunPreview eff={eff} />
          </Box>
          <Box sx={{ pt: 4, display: "flex", justifyContent: "center" }}>
            <Button
              leadingVisual={PlayIcon}
              variant="primary"
              size="large"
              onClick={onStart}
              disabled={busy}
              sx={{ minWidth: 240 }}
            >
              {busy ? "Starting…" : "Tackle this task"}
            </Button>
          </Box>
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
          mono={!!eff.branch}
          value={eff.branch || "create a new branch"}
        />
        <Fact
          icon={<GitMergeIcon size={14} />}
          label="PR target"
          mono={eff.submitPr && !!eff.baseBranch}
          value={
            eff.submitPr
              ? eff.baseBranch || "the repo's default branch"
              : "not opening a PR"
          }
          muted={!eff.submitPr}
        />
        <Fact
          icon={<PackageIcon size={14} />}
          label="Workdir"
          value={eff.useWorktree ? "isolated git worktree" : "the workspace, in place"}
        />
      </Box>

      <Box sx={{ mt: 1 }}>
        <Text sx={{ fontSize: 0, fontWeight: 600, color: "fg.muted", display: "block", mb: 2 }}>
          Pipeline
        </Text>
        <PhaseDots phases={phases} />
      </Box>
    </Box>
  );
}

/**
 * Each phase rendered as a small colored dot + label. Phases get different
 * hues for visual variety without the chrome of pills or icon stacks.
 * Wraps gracefully on narrow widths.
 */
function PhaseDots({
  phases,
}: {
  phases: { kind: string; label: string; color: string }[];
}) {
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", columnGap: 3, rowGap: 2, alignItems: "center" }}>
      {phases.map((p) => (
        <Box key={p.kind} sx={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <Box
            aria-hidden
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              bg: p.color,
              boxShadow: `0 0 0 3px ${p.color}1f`,
            }}
          />
          <Text sx={{ fontSize: 1 }}>{p.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

function Fact({
  icon,
  label,
  value,
  mono,
  muted,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, minHeight: 24 }}>
      <Box sx={{ display: "inline-flex", color: "fg.muted" }} aria-hidden>
        {icon}
      </Box>
      <Text sx={{ fontSize: 0, color: "fg.muted", fontWeight: 600, minWidth: 76 }}>
        {label}
      </Text>
      <Text
        sx={{
          fontSize: 1,
          color: muted ? "fg.muted" : "fg.default",
          fontFamily: mono ? "mono" : undefined,
          lineHeight: 1.5,
        }}
      >
        {value}
      </Text>
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
  update: (patch: Partial<Omit<Effective, "task">>, opts?: { persist?: boolean }) => void;
}) {
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
            value={eff.branch}
            onChange={(v) => update({ branch: v }, { persist: false })}
            onCommit={() => update({ branch: eff.branch })}
            placeholder="(new)"
          />
          <InputRow
            label="Target branch"
            value={eff.baseBranch}
            onChange={(v) => update({ baseBranch: v }, { persist: false })}
            onCommit={() => update({ baseBranch: eff.baseBranch })}
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
