import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnchoredOverlay, Box, IconButton, Text } from "@primer/react";
import { BellIcon, TrashIcon } from "@primer/octicons-react";
import {
  InboxItem,
  clearAll,
  dismissItem,
  useInboxItems,
} from "../notificationInbox";

/**
 * Map an inbox item to the route the user should land on when they
 * click through. `newTask` goes to the description tab; everything
 * else is run-tab-relevant (waiting/failed/needs_input/taskFinished).
 */
function routeFor(item: InboxItem): string {
  if (item.kind === "newTask") return `/tasks/${item.taskId}`;
  return `/tasks/${item.taskId}?tab=run`;
}

function formatRelative(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  const sec = Math.round(delta / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function NotificationBell() {
  const items = useInboxItems();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const hasItems = items.length > 0;
  const now = useMemo(() => Date.now(), [open, items]);

  const handleItemClick = (item: InboxItem) => {
    dismissItem(item.id);
    setOpen(false);
    navigate(routeFor(item));
  };

  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      align="end"
      renderAnchor={(anchorProps) => (
        <Box
          as="button"
          type="button"
          {...anchorProps}
          aria-label="Notifications"
          title="Notifications"
          data-tauri-drag-region={false}
          sx={{
            position: "relative",
            width: 32,
            height: 32,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            cursor: "pointer",
            borderRadius: 2,
            color: open ? "fg.default" : "fg.muted",
            bg: open ? "neutral.muted" : "transparent",
            transition: "background-color 80ms",
            "&:hover": {
              bg: open ? "neutral.muted" : "neutral.subtle",
              color: "fg.default",
            },
          }}
        >
          <BellIcon size={16} />
          {hasItems && (
            <Box
              aria-hidden
              sx={{
                position: "absolute",
                top: 6,
                right: 6,
                width: 8,
                height: 8,
                borderRadius: 999,
                bg: "accent.fg",
                borderWidth: 2,
                borderStyle: "solid",
                borderColor: open ? "neutral.muted" : "canvas.subtle",
              }}
            />
          )}
        </Box>
      )}
      overlayProps={{ "data-tauri-drag-region": false } as Record<string, unknown>}
    >
      <Box
        data-tauri-drag-region={false}
        sx={{
          width: 360,
          maxHeight: 400,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            px: 3,
            py: 2,
            borderBottomWidth: 1,
            borderBottomStyle: "solid",
            borderBottomColor: "border.muted",
          }}
        >
          <Text sx={{ fontWeight: 600, fontSize: 1 }}>Notifications</Text>
          <IconButton
            icon={TrashIcon}
            aria-label="Clear all notifications"
            size="small"
            variant="invisible"
            disabled={!hasItems}
            onClick={() => clearAll()}
          />
        </Box>

        {!hasItems && (
          <Box sx={{ p: 4, textAlign: "center" }}>
            <Text sx={{ color: "fg.muted", fontSize: 1 }}>
              You're all caught up.
            </Text>
          </Box>
        )}

        {hasItems && (
          <Box sx={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
            {items.map((item) => (
              <Box
                key={item.id}
                as="button"
                type="button"
                onClick={() => handleItemClick(item)}
                data-tauri-drag-region={false}
                sx={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  bg: "transparent",
                  cursor: "pointer",
                  px: 3,
                  py: 2,
                  borderBottomWidth: 1,
                  borderBottomStyle: "solid",
                  borderBottomColor: "border.muted",
                  "&:last-child": { borderBottomWidth: 0 },
                  "&:hover": { bg: "neutral.subtle" },
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 2,
                  }}
                >
                  <Text sx={{ fontWeight: 600, fontSize: 1, color: "fg.default" }}>
                    {item.title}
                  </Text>
                  <Text
                    sx={{
                      fontSize: 0,
                      color: "fg.muted",
                      flexShrink: 0,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {formatRelative(item.ts, now)}
                  </Text>
                </Box>
                <Text
                  sx={{
                    display: "block",
                    fontSize: 1,
                    color: "fg.muted",
                    mt: 1,
                  }}
                >
                  {item.body}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </AnchoredOverlay>
  );
}
