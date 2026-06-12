import { Box } from "@primer/react";
import { GearIcon, HomeIcon } from "@primer/octicons-react";
import { Link, Outlet, useLocation } from "react-router-dom";

export function Layout() {
  const { pathname } = useLocation();

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Box
        data-tauri-drag-region
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          pl: "84px",        // reserve space for macOS traffic lights
          pr: 3,
          minHeight: 52,
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
            fontSize: 16,
            color: "var(--fgColor-default)",
            textDecoration: "none",
          }}
        >
          Conveyer
        </Link>
        <Box sx={{ flex: 1 }} data-tauri-drag-region />
        <NavLink
          to="/"
          label="Dashboard"
          active={pathname === "/" || pathname.startsWith("/tasks")}
        >
          <HomeIcon size={16} />
        </NavLink>
        <NavLink to="/settings" label="Settings" active={pathname.startsWith("/settings")}>
          <GearIcon size={16} />
        </NavLink>
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
