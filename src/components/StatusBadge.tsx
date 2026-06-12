import { Label } from "@primer/react";

const variantMap: Record<string, "default" | "accent" | "success" | "attention" | "danger" | "done"> = {
  pending: "default",
  running: "accent",
  waiting: "attention",
  done: "done",
  failed: "danger",
  cancelled: "default",
  skipped: "default",
};

const labelMap: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Awaiting Approval",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

const PHASE_TITLE: Record<string, string> = {
  exploration: "Exploration",
  planning: "Planning",
  implementation: "Implementation",
  review: "Review",
  submit: "Submit",
};

/**
 * Renders a coloured pill summarising a task's run state. When a phase is
 * provided, prefers to show the phase name + suffix (Running / Awaiting),
 * which is what users care about while a run is in flight.
 */
export function StatusBadge({
  status,
  phase,
}: {
  status: string | null | undefined;
  phase?: string | null;
}) {
  if (!status) return <Label variant="default">Not Tackled</Label>;
  const v = variantMap[status] ?? "default";
  if (phase && (status === "running" || status === "waiting")) {
    const phaseLabel = PHASE_TITLE[phase] ?? phase;
    const suffix = status === "waiting" ? "Awaiting Approval" : "In Progress";
    return <Label variant={v}>{`${phaseLabel} · ${suffix}`}</Label>;
  }
  return <Label variant={v}>{labelMap[status] ?? status}</Label>;
}
