import { Box, Header } from "@primer/react";
import { GearIcon, HomeIcon, MoonIcon, SunIcon } from "@primer/octicons-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useColorMode } from "../theme";

export function Layout() {
  const { pathname } = useLocation();
  const { mode, toggle } = useColorMode();

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Box
        // The whole strip is draggable so users can move the window from
        // any empty area. Interactive children opt out below.
        data-tauri-drag-region
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          // Reserve room for macOS traffic-light buttons on the left.
          pl: "84px",
          pr: 3,
          py: 2,
          borderBottomWidth: 1,
          borderBottomStyle: "solid",
          borderBottomColor: "border.default",
          bg: "canvas.subtle",
        }}
      >
        <Header.Link
          as={Link}
          to="/"
          sx={{ fontWeight: "bold", fontSize: 2 }}
          data-tauri-drag-region={false}
        >
          Conveyer
        </Header.Link>
        <Box sx={{ flex: 1 }} data-tauri-drag-region />
        <NavLink
          to="/"
          label="Dashboard"
          active={pathname === "/" || pathname.startsWith("/tasks")}
        >
          <HomeIcon size={16} />
        </NavLink>
        <NavLink to="/settings" label="Settings" active={pathname === "/settings"}>
          <GearIcon size={16} />
        </NavLink>
        <IconLink
          onClick={toggle}
          label={mode === "night" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {mode === "night" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </IconLink>
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

const iconBoxStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 6,
  textDecoration: "none",
  border: "none",
  cursor: "pointer",
  background: "transparent",
};

function NavLink({
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
    <Link
      to={to}
      aria-label={label}
      title={label}
      data-tauri-drag-region={false}
      style={{
        ...iconBoxStyle,
        color: active ? "var(--fgColor-default)" : "var(--fgColor-muted)",
        background: active ? "var(--bgColor-neutral-muted)" : "transparent",
      }}
    >
      {children}
    </Link>
  );
}

function IconLink({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-tauri-drag-region={false}
      style={{
        ...iconBoxStyle,
        color: "var(--fgColor-muted)",
      }}
    >
      {children}
    </button>
  );
}
