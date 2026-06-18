import { useEffect, useState } from "react";
import { Box, FormControl, Spinner, Text, TextInput, ToggleSwitch } from "@primer/react";
import { ChevronDownIcon, ChevronRightIcon } from "@primer/octicons-react";
import { api } from "../api";
import { Task } from "../types";
import { formatError } from "../errors";

/**
 * Collapsed-by-default panel that exposes per-task overrides on top of the
 * global defaults: whether to use a git worktree, the PR target/base branch,
 * an existing branch to work on, and whether to run the submit phase.
 *
 * All four are persisted with one debounced `task_overrides_set` call. NULL
 * means "inherit the global default" — the UI shows the inherited value as
 * placeholder text so the user can see what they'd get without overriding.
 *
 * Lives above the start button so it's set before the run, but stays visible
 * (and editable) during a run for the *next* run.
 */
export function TaskRunSettings({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [globalUseWorktree, setGlobalUseWorktree] = useState<boolean>(true);
  const [globalSubmitEnabled, setGlobalSubmitEnabled] = useState<boolean>(true);

  // Local controlled state for the four overrides.
  const [useWorktree, setUseWorktree] = useState<boolean | null>(null);
  const [enableSubmit, setEnableSubmit] = useState<boolean | null>(null);
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
        setUseWorktree(t?.use_worktree == null ? null : t.use_worktree !== 0);
        setEnableSubmit(t?.enable_submit == null ? null : t.enable_submit !== 0);
        setBaseBranch(t?.base_branch_override ?? "");
        setBranch(t?.branch_override ?? "");
        setGlobalUseWorktree(gWt !== "0" && gWt?.toLowerCase() !== "false");
        setGlobalSubmitEnabled(gSub !== "0" && gSub?.toLowerCase() !== "false");
      } catch (e) {
        if (!cancelled) setError(formatError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const save = async (next: {
    useWorktree?: boolean | null;
    enableSubmit?: boolean | null;
    baseBranch?: string;
    branch?: string;
  }) => {
    const merged = {
      useWorktree: next.useWorktree !== undefined ? next.useWorktree : useWorktree,
      enableSubmit: next.enableSubmit !== undefined ? next.enableSubmit : enableSubmit,
      baseBranchOverride: next.baseBranch !== undefined ? next.baseBranch : baseBranch,
      branchOverride: next.branch !== undefined ? next.branch : branch,
    };
    try {
      await api.taskOverridesSet(taskId, {
        useWorktree: merged.useWorktree,
        enableSubmit: merged.enableSubmit,
        baseBranchOverride: merged.baseBranchOverride.trim() || null,
        branchOverride: merged.branchOverride.trim() || null,
      });
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  };

  const hasOverride =
    useWorktree !== null ||
    enableSubmit !== null ||
    !!baseBranch.trim() ||
    !!branch.trim();

  if (loading) {
    return <Spinner size="small" />;
  }

  return (
    <Box
      sx={{
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        bg: "canvas.subtle",
      }}
    >
      <Box
        as="button"
        type="button"
        onClick={() => setOpen((o) => !o)}
        sx={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 2,
          background: "transparent",
          border: "none",
          p: 2,
          cursor: "pointer",
          color: "fg.default",
          textAlign: "left",
        }}
      >
        <Box sx={{ display: "inline-flex", color: "fg.muted" }} aria-hidden>
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </Box>
        <Text sx={{ fontSize: 1, fontWeight: 500 }}>Run settings</Text>
        <Text sx={{ fontSize: 0, color: "fg.muted" }}>
          {hasOverride ? "· custom for this task" : "· using global defaults"}
        </Text>
      </Box>

      {open && (
        <Box
          sx={{
            borderTopWidth: 1,
            borderTopStyle: "solid",
            borderTopColor: "border.default",
            p: 3,
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {error && (
            <Text sx={{ fontSize: 0, color: "danger.fg" }}>{error}</Text>
          )}

          {/* Worktree toggle (with explicit "inherit" choice) */}
          <Row
            label="Worktree"
            help={
              useWorktree === null
                ? `Inherits global default — ${globalUseWorktree ? "use worktree" : "work in repo directly"}`
                : useWorktree
                  ? "Run gets its own git worktree"
                  : "Run uses the workspace directly (current branch, in place)"
            }
          >
            <TristateToggle
              value={useWorktree}
              onChange={(v) => {
                setUseWorktree(v);
                void save({ useWorktree: v });
              }}
            />
          </Row>

          {/* Base branch override */}
          <Row
            label="Base branch"
            help="The branch the PR targets (and the diff is taken against). Leave blank to auto-detect from the remote default."
          >
            <TextInput
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              onBlur={() => void save({ baseBranch })}
              placeholder="(auto)"
              sx={{ width: 220 }}
              monospace
            />
          </Row>

          {/* Working branch override */}
          <Row
            label="Branch"
            help={
              "An existing branch to work on, instead of creating a new one. " +
              "Leave blank to let Conveyer create `<alias>/<slug>`."
            }
          >
            <TextInput
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              onBlur={() => void save({ branch })}
              placeholder="(new branch)"
              sx={{ width: 220 }}
              monospace
            />
          </Row>

          {/* Submit toggle */}
          <Row
            label="Submit phase"
            help={
              enableSubmit === null
                ? `Inherits global default — ${globalSubmitEnabled ? "runs end with opening a PR" : "runs end after review"}`
                : enableSubmit
                  ? "Runs end with opening a PR"
                  : "Runs end after review (no PR)"
            }
          >
            <TristateToggle
              value={enableSubmit}
              onChange={(v) => {
                setEnableSubmit(v);
                void save({ enableSubmit: v });
              }}
            />
          </Row>
          <Text sx={{ fontSize: 0, color: "fg.muted" }}>
            Changes apply to the next run.{task ? "" : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function Row({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 3 }}>
      <FormControl sx={{ flex: 1, minWidth: 0 }}>
        <FormControl.Label>{label}</FormControl.Label>
        <FormControl.Caption>{help}</FormControl.Caption>
      </FormControl>
      <Box sx={{ flexShrink: 0 }}>{children}</Box>
    </Box>
  );
}

/**
 * Three-state toggle: Inherit (null), On (true), Off (false). Rendered as a
 * compact segmented row so users can see all three positions at once.
 */
function TristateToggle({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const opts: { v: boolean | null; label: string }[] = [
    { v: null, label: "Inherit" },
    { v: true, label: "On" },
    { v: false, label: "Off" },
  ];
  return (
    <Box
      sx={{
        display: "inline-flex",
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      {opts.map((o, i) => {
        const active = value === o.v;
        return (
          <Box
            key={String(o.v)}
            as="button"
            type="button"
            onClick={() => onChange(o.v)}
            sx={{
              px: 2,
              py: 1,
              border: "none",
              fontSize: 0,
              cursor: "pointer",
              bg: active ? "accent.subtle" : "transparent",
              color: active ? "accent.fg" : "fg.default",
              fontWeight: active ? "semibold" : "normal",
              borderLeftWidth: i === 0 ? 0 : 1,
              borderLeftStyle: "solid",
              borderLeftColor: "border.default",
              "&:hover": { bg: active ? "accent.subtle" : "neutral.subtle" },
            }}
            aria-pressed={active}
          >
            {o.label}
          </Box>
        );
      })}
    </Box>
  );
}

// The "uses ToggleSwitch import" comment was here to avoid TS unused-import
// in IDE; we now render our own TristateToggle instead.
void ToggleSwitch;
