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

const PHASES: { kind: string; label: string }[] = [
  { kind: "exploration", label: "Exploration" },
  { kind: "planning", label: "Planning" },
  { kind: "implementation", label: "Implementation" },
  { kind: "review", label: "Review" },
  { kind: "submit", label: "Submit PR" },
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
            justifyContent: "center",
            alignItems: "flex-start",
            minWidth: 0,
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
  const phaseLine = useMemo(() => {
    if (!eff) return null;
    return PHASES.filter((p) => p.kind !== "submit" || eff.submitPr).map((p) => p.label);
  }, [eff]);

  if (!eff || !phaseLine) return null;

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

      <Box>
        <Text sx={{ fontSize: 0, fontWeight: 600, color: "fg.muted", display: "block", mb: 1 }}>
          Phases
        </Text>
        <Text
          sx={{
            fontSize: 1,
            color: "fg.default",
            lineHeight: 1.6,
            wordBreak: "break-word",
          }}
        >
          {phaseLine.map((label, i) => (
            <span key={label}>
              {label}
              {i < phaseLine.length - 1 && (
                <Text as="span" sx={{ color: "fg.muted", mx: 2 }}>›</Text>
              )}
            </span>
          ))}
        </Text>
      </Box>
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
