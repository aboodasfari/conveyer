import { Box, Text } from "@primer/react";
import { DownloadIcon, GearIcon, SyncIcon, CheckIcon } from "@primer/octicons-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useUpdateStatus, installAndRelaunch } from "../updater";
import { NotificationBell } from "./NotificationBell";

interface NavItem {
  to: string;
  label: string;
  exact?: boolean;
}

const BUCKET_NAV: NavItem[] = [
  { to: "/", label: "Active", exact: true },
  { to: "/backlog", label: "Backlog" },
  { to: "/archive", label: "Archive" },
];

export function Layout() {
  const { pathname } = useLocation();

  const isActive = (item: NavItem) => {
    if (item.exact) return pathname === item.to;
    return pathname === item.to || pathname.startsWith(`${item.to}/`);
  };

  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Box
        data-tauri-drag-region
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: 1,
          pl: "104px",
          pr: 3,
          minHeight: 48,
          borderBottomWidth: 1,
          borderBottomStyle: "solid",
          borderBottomColor: "border.default",
          bg: "canvas.subtle",
        }}
      >
        <Link
          to="/"
          data-tauri-drag-region={false}
          style={{
            fontWeight: 600,
            fontSize: 15,
            color: "var(--fgColor-default)",
            textDecoration: "none",
            marginRight: 16,
          }}
        >
          Conveyer
        </Link>
        <Box sx={{ display: "flex", gap: 1, flex: 1 }} data-tauri-drag-region>
          {BUCKET_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} label={item.label} active={isActive(item)} />
          ))}
        </Box>
        <UpdateButton />
        <NotificationBell />
        <IconNavLink to="/settings" label="Settings" active={settingsActive}>
          <GearIcon size={16} />
        </IconNavLink>
      </Box>
      <Box
        as="main"
        sx={{ p: 4, flex: 1, maxWidth: 1200, mx: "auto", width: "100%" }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}

function NavLink({
  to,
  label,
  active,
}: {
  to: string;
  label: string;
  active: boolean;
}) {
  return (
    <Box
      as={Link}
      to={to}
      data-tauri-drag-region={false}
      sx={{
        px: 2,
        py: 1,
        fontSize: 1,
        textDecoration: "none",
        borderRadius: 2,
        color: active ? "fg.default" : "fg.muted",
        bg: active ? "neutral.muted" : "transparent",
        fontWeight: active ? 600 : 400,
        transition: "background-color 80ms",
        "&:hover": {
          bg: active ? "neutral.muted" : "neutral.subtle",
          color: "fg.default",
        },
      }}
    >
      {label}
    </Box>
  );
}

function IconNavLink({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box
      as={Link}
      to={to}
      aria-label={label}
      title={label}
      data-tauri-drag-region={false}
      sx={{
        width: 32,
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        textDecoration: "none",
        borderRadius: 2,
        color: active ? "fg.default" : "fg.muted",
        bg: active ? "neutral.muted" : "transparent",
        transition: "background-color 80ms",
        "&:hover": {
          bg: active ? "neutral.muted" : "neutral.subtle",
          color: "fg.default",
        },
      }}
    >
      {children}
    </Box>
  );
}

function UpdateButton() {
  const update = useUpdateStatus();
  const visible =
    update.status === "available" ||
    update.status === "downloading" ||
    update.status === "ready";
  if (!visible) return null;

  const downloading = update.status === "downloading";
  const ready = update.status === "ready";
  const errored = update.status === "error";

  const pct = (() => {
    const p = update.progress;
    if (!p || !p.total) return null;
    return Math.min(100, Math.round((p.downloaded / p.total) * 100));
  })();

  const label = downloading
    ? `Downloading update… ${pct !== null ? `${pct}%` : ""}`.trim()
    : ready
      ? "Update installed — restarting"
      : errored
        ? `Update failed — ${update.error ?? "click to retry"}`
        : `Update available${update.version ? ` — v${update.version}` : ""} — click to install`;

  // No modal: clicking auto-downloads, installs, and relaunches.
  const onClick = () => {
    if (downloading || ready) return;
    void installAndRelaunch();
  };

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
      {downloading && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Box
            sx={{
              width: 96,
              height: 4,
              borderRadius: 999,
              bg: "neutral.muted",
              overflow: "hidden",
            }}
          >
            <Box
              sx={{
                width: pct !== null ? `${pct}%` : "40%",
                height: "100%",
                bg: "accent.fg",
                transition: "width 120ms linear",
                animation: pct === null ? "conveyer-updater-indeterminate 1.1s ease-in-out infinite" : undefined,
              }}
            />
          </Box>
          {pct !== null && (
            <Text sx={{ fontSize: 0, color: "fg.muted", fontVariantNumeric: "tabular-nums", minWidth: 28 }}>
              {pct}%
            </Text>
          )}
        </Box>
      )}
      <Box
        as="button"
        type="button"
        onClick={onClick}
        disabled={downloading || ready}
        aria-label={label}
        title={label}
        data-tauri-drag-region={false}
        sx={{
          width: 32,
          height: 32,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          cursor: downloading || ready ? "default" : "pointer",
          borderRadius: 2,
          color: errored ? "danger.fg" : "accent.fg",
          bg: "transparent",
          opacity: downloading || ready ? 0.6 : 1,
          transition: "background-color 80ms, opacity 80ms",
          "&:hover": { bg: downloading || ready ? "transparent" : "neutral.subtle" },
          "& > span": downloading || ready
            ? {
                display: "inline-flex",
                transform: "translateY(1px)",
                animation: ready ? undefined : "conveyer-updater-spin 1.2s linear infinite",
              }
            : { display: "inline-flex", transform: "translateY(1px)" },
          "@keyframes conveyer-updater-spin": {
            from: { transform: "rotate(0deg)" },
            to: { transform: "rotate(360deg)" },
          },
          "@keyframes conveyer-updater-indeterminate": {
            "0%": { transform: "translateX(-100%)" },
            "100%": { transform: "translateX(250%)" },
          },
        }}
      >
        <span>
          {downloading ? (
            <SyncIcon size={16} />
          ) : ready ? (
            <CheckIcon size={16} />
          ) : (
            <DownloadIcon size={16} />
          )}
        </span>
      </Box>
    </Box>
  );
}
