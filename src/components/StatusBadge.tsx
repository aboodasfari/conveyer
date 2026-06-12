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

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Label variant="default">no run</Label>;
  const v = variantMap[status] ?? "default";
  return <Label variant={v}>{status}</Label>;
}
