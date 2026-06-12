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
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Label variant="default">Not Tackled</Label>;
  const v = variantMap[status] ?? "default";
  return <Label variant={v}>{labelMap[status] ?? status}</Label>;
}
