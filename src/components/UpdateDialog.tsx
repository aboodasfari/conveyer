import { Box, Button, Text } from "@primer/react";
import { Dialog } from "@primer/react/experimental";
import { useUpdateStatus, installAndRelaunch } from "../updater";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateDialog({ isOpen, onClose }: Props) {
  const update = useUpdateStatus();
  if (!isOpen) return null;

  const downloading = update.status === "downloading";
  const ready = update.status === "ready";
  const errored = update.status === "error";

  const progressPct = (() => {
    if (!update.progress) return null;
    const { downloaded, total } = update.progress;
    if (!total) return `${formatBytes(downloaded)} downloaded`;
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    return `${pct}% — ${formatBytes(downloaded)} / ${formatBytes(total)}`;
  })();

  return (
    <Dialog
      onClose={onClose}
      title={ready ? "Restarting…" : "Update available"}
      width="medium"
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <Box>
          <Text sx={{ display: "block", fontSize: 1 }}>
            <strong>{update.currentVersion ?? "current"}</strong>
            {" → "}
            <strong>{update.version ?? "new"}</strong>
          </Text>
        </Box>
        {update.notes && (
          <Box
            sx={{
              maxHeight: 200,
              overflowY: "auto",
              fontSize: 0,
              p: 2,
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "border.default",
              borderRadius: 2,
              whiteSpace: "pre-wrap",
              fontFamily: "mono",
            }}
          >
            {update.notes}
          </Box>
        )}
        <Text sx={{ fontSize: 0, color: "fg.muted" }}>
          Conveyer will restart. Any active runs will be interrupted.
        </Text>
        {downloading && progressPct && (
          <Text sx={{ fontSize: 0, color: "fg.muted" }}>{progressPct}</Text>
        )}
        {errored && update.error && (
          <Text sx={{ fontSize: 0, color: "danger.fg" }}>{update.error}</Text>
        )}
        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
          <Button onClick={onClose} disabled={downloading}>
            {ready ? "Close" : "Cancel"}
          </Button>
          {!ready && (
            <Button
              variant="primary"
              onClick={() => {
                void installAndRelaunch();
              }}
              disabled={downloading}
            >
              {errored ? "Retry" : downloading ? "Installing…" : "Install & restart"}
            </Button>
          )}
        </Box>
      </Box>
    </Dialog>
  );
}
