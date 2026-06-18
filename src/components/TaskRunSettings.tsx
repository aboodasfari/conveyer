import { useEffect, useMemo, useState } from "react";
import { Box, Button, Flash, IconButton, Spinner, Text, TextInput, ToggleSwitch } from "@primer/react";
import { ChevronRightIcon, HistoryIcon, PlayIcon, SlidersIcon } from "@primer/octicons-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Task } from "../types";
import { formatError } from "../errors";
import { onSettingChanged } from "../settingsBus";

interface Effective {
  task: Task;
  useWorktree: boolean;
  useWorktreeExplicit: boolean;
  submitPr: boolean;
  submitPrExplicit: boolean;
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
  // Closed by default; ?settings=open in the URL opens it on first mount
  // (used by the dashboard's "Custom Tackle" path).
  const [searchParams] = useSearchParams();
  const [collapsed, setCollapsed] = useState<boolean>(
    searchParams.get("settings") !== "open",
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
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
          useWorktreeExplicit: task.use_worktree != null,
          submitPr: task.enable_submit == null ? globalSub : task.enable_submit !== 0,
          submitPrExplicit: task.enable_submit != null,
          baseBranch: task.base_branch_override ?? "",
          branch: task.branch_override ?? "",
        });
      } catch (e) {
        if (!cancelled) setLoadError(formatError(e));
      }
    };
    void load();
    // Listen for global setting changes (made elsewhere — typically the
    // Settings page) so inherited toggles follow the new global immediately.
    const off = onSettingChanged((key) => {
      if (key === "use_worktree" || key === "phase_submit_enabled") {
        void load();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [taskId]);

  // Apply a partial update. When opts.persist is false (default true), the
  // change is reflected in local state only — used by text inputs so the
  // preview reacts on every keystroke while we save on blur. Set
  // useWorktreeExplicit / submitPrExplicit to false explicitly via the patch
  // when you want to revert a toggle to "inherit from global".
  const update = async (
    patch: Partial<Omit<Effective, "task">>,
    opts: { persist?: boolean } = {},
  ) => {
    if (!eff) return;
    // Auto-flip explicit flags when the underlying value is set without an
    // explicit instruction (typical for toggle clicks).
    const next: Effective = { ...eff, ...patch };
    if ("useWorktree" in patch && !("useWorktreeExplicit" in patch)) {
      next.useWorktreeExplicit = true;
    }
    if ("submitPr" in patch && !("submitPrExplicit" in patch)) {
      next.submitPrExplicit = true;
    }
    setEff(next);
    if (opts.persist === false) return;
    try {
      await api.taskOverridesSet(taskId, {
        useWorktree: next.useWorktreeExplicit ? next.useWorktree : null,
        enableSubmit: next.submitPrExplicit ? next.submitPr : null,
        baseBranchOverride: next.baseBranch.trim() || null,
        branchOverride: next.branch.trim() || null,
      });
    } catch (e) {
      setLoadError(formatError(e));
    }
  };

  // Revert a toggle to the global default. Re-reads the global value so the
  // local toggle reflects what users actually see in Settings, and clears
  // the per-task override in the DB.
  const revertToInherit = async (field: "useWorktree" | "submitPr") => {
    if (!eff) return;
    try {
      const key = field === "useWorktree" ? "use_worktree" : "phase_submit_enabled";
      const v = await api.settingGet(key);
      const inheritedValue = v !== "0" && v?.toLowerCase() !== "false";
      if (field === "useWorktree") {
        await update({ useWorktree: inheritedValue, useWorktreeExplicit: false });
      } else {
        await update({ submitPr: inheritedValue, submitPrExplicit: false });
      }
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
          gridTemplateColumns: collapsed ? "1fr 0px" : "1fr 340px",
          gap: collapsed ? 0 : 4,
          alignItems: "stretch",
          flex: 1,
          minHeight: 0,
          position: "relative",
          transition: "grid-template-columns 200ms ease, gap 200ms ease",
        }}
      >
        {/* Cog overlay anchored to the grid's top-right corner. Visible only
            when the right panel is collapsed; expanded state uses the
            in-card chevron at the same corner of the card. */}
        {collapsed && (
          <Box sx={{ position: "absolute", top: 0, right: 0, zIndex: 2 }}>
            <IconButton
              aria-label="Show run settings"
              icon={SlidersIcon}
              variant="invisible"
              onClick={() => setCollapsed(false)}
              size="small"
            />
          </Box>
        )}
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            pt: 1,
          }}
        >
          <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
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
        <RunSettingsCard
          eff={eff}
          update={update}
          revert={revertToInherit}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
        />
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
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        alignItems: "center",
        textAlign: "center",
        maxWidth: 520,
        minWidth: 0,
        width: "100%",
      }}
    >
      <Text sx={{ fontWeight: 600, fontSize: 2, color: "fg.default" }}>
        This run will…
      </Text>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
        <Fact
          label="Branch"
          mono={!!eff.branch}
          value={eff.branch || "create a new branch"}
        />
        <Fact
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
          label="Workdir"
          value={eff.useWorktree ? "isolated git worktree" : "the workspace, in place"}
        />
      </Box>

      <Pipeline phases={phases} />
    </Box>
  );
}

/**
 * Phase pipeline: small connected dots with labels beneath. Subtle accent
 * color, thin connector lines between each dot — reads as a pipeline rather
 * than a list. Wraps gracefully.
 */
function Pipeline({
  phases,
}: {
  phases: { kind: string; label: string }[];
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        flexWrap: "wrap",
        rowGap: 3,
        justifyContent: "center",
        userSelect: "none",
      }}
    >
      {phases.map((p, i) => {
        const isLast = i === phases.length - 1;
        return (
          <Box
            key={p.kind}
            sx={{
              display: "flex",
              alignItems: "flex-start",
              flex: isLast ? "0 0 auto" : "1 1 0",
              minWidth: 72,
            }}
          >
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 1,
                minWidth: 72,
              }}
            >
              <Box
                aria-hidden
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  bg: "accent.fg",
                }}
              />
              <Text sx={{ fontSize: 0, color: "fg.muted" }}>{p.label}</Text>
            </Box>
            {!isLast && (
              <Box
                aria-hidden
                sx={{
                  flex: 1,
                  height: 2,
                  bg: "accent.fg",
                  opacity: 0.35,
                  mt: "4px",
                  mx: 1,
                  borderRadius: 1,
                  minWidth: 24,
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
  label,
  value,
  mono,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "baseline", gap: 2, minHeight: 24 }}>
      <Text sx={{ fontSize: 0, color: "fg.muted", fontWeight: 600 }}>
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
  revert,
  collapsed,
  onToggleCollapsed,
}: {
  eff: Effective | null;
  update: (patch: Partial<Omit<Effective, "task">>, opts?: { persist?: boolean }) => void;
  revert: (field: "useWorktree" | "submitPr") => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  // When collapsed: shrink the grid cell to nothing, clip the card so it
  // animates out smoothly. The floating cog overlay (rendered by the
  // parent) is what the user clicks to reopen.
  return (
    <Box sx={{ overflow: "hidden", minWidth: 0, minHeight: 0, display: "flex" }}>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          width: 340,
          opacity: collapsed ? 0 : 1,
          pointerEvents: collapsed ? "none" : "auto",
          transition: "opacity 160ms ease",
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
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Text sx={{ fontWeight: 600, fontSize: 1 }}>Run settings</Text>
          <IconButton
            aria-label="Hide run settings"
            icon={ChevronRightIcon}
            variant="invisible"
            onClick={onToggleCollapsed}
            size="small"
          />
        </Box>

        {!eff ? (
          <Spinner size="small" />
        ) : (
          <>
            <ToggleRow
              label="Submit PR"
              checked={eff.submitPr}
              onChange={(v) => update({ submitPr: v })}
              explicit={eff.submitPrExplicit}
              onRevert={() => revert("submitPr")}
            />
            <ToggleRow
              label="Use worktree"
              checked={eff.useWorktree}
              onChange={(v) => update({ useWorktree: v })}
              explicit={eff.useWorktreeExplicit}
              onRevert={() => revert("useWorktree")}
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
    </Box>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  explicit,
  onRevert,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** True if the value has been explicitly set on this task (i.e. won't
   *  follow the global default). When false, the toggle shows the inherited
   *  value and the revert affordance is hidden (already inherited). */
  explicit?: boolean;
  onRevert?: () => void;
}) {
  // Reserve constant slots for the "inherited" tag and the revert button so
  // the row height stays fixed whether or not they're visible.
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 2,
        minHeight: 28,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
        <Text sx={{ fontSize: 1 }}>{label}</Text>
        <Text
          sx={{
            fontSize: 0,
            color: "fg.muted",
            visibility: explicit ? "hidden" : "visible",
          }}
        >
          · inherited
        </Text>
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ visibility: explicit && onRevert ? "visible" : "hidden" }}>
          <IconButton
            aria-label={`Reset ${label} to global default`}
            icon={HistoryIcon}
            variant="invisible"
            size="small"
            onClick={onRevert}
          />
        </Box>
        <ToggleSwitch
          checked={checked}
          onClick={() => onChange(!checked)}
          aria-label={label}
          size="small"
        />
      </Box>
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
