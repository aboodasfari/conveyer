import { Box } from "@primer/react";
import { DownloadIcon, GearIcon } from "@primer/octicons-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { useUpdateStatus } from "../updater";
import { UpdateDialog } from "./UpdateDialog";

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
  const [open, setOpen] = useState(false);
  const visible =
    update.status === "available" ||
    update.status === "downloading" ||
    update.status === "ready";
  if (!visible) return null;
  const spinning = update.status === "downloading";
  const label =
    update.status === "downloading"
      ? "Installing update…"
      : update.status === "ready"
        ? "Update installed — restarting"
        : `Update available${update.version ? ` — v${update.version}` : ""}`;
  return (
    <>
      <Box
        as="button"
        type="button"
        onClick={() => setOpen(true)}
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
          cursor: "pointer",
          borderRadius: 2,
          color: "accent.fg",
          bg: "transparent",
          transition: "background-color 80ms",
          "&:hover": {
            bg: "neutral.subtle",
          },
          "& > span": spinning
            ? {
                display: "inline-flex",
                transform: "translateY(1px)",
                animation: "conveyer-updater-spin 1.2s linear infinite",
              }
            : { display: "inline-flex", transform: "translateY(1px)" },
          "@keyframes conveyer-updater-spin": {
            from: { transform: "rotate(0deg)" },
            to: { transform: "rotate(360deg)" },
          },
        }}
      >
        <span>
          <DownloadIcon size={16} />
        </span>
      </Box>
      <UpdateDialog isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}
