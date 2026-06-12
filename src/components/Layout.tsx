import { Box, Header } from "@primer/react";
import { GearIcon, HomeIcon } from "@primer/octicons-react";
import { Link, Outlet, useLocation } from "react-router-dom";

export function Layout() {
  const { pathname } = useLocation();
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header>
        <Header.Item>
          <Header.Link as={Link} to="/" sx={{ fontWeight: "bold", fontSize: 2 }}>
            Conveyer
          </Header.Link>
        </Header.Item>
        <Header.Item full />
        <Header.Item>
          <NavLink to="/" label="Dashboard" active={pathname === "/" || pathname.startsWith("/tasks")}>
            <HomeIcon size={16} />
          </NavLink>
        </Header.Item>
        <Header.Item>
          <NavLink to="/settings" label="Settings" active={pathname === "/settings"}>
            <GearIcon size={16} />
          </NavLink>
        </Header.Item>
      </Header>
      <Box as="main" sx={{ p: 4, flex: 1, maxWidth: 1200, mx: "auto", width: "100%" }}>
        <Outlet />
      </Box>
    </Box>
  );
}

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
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        borderRadius: 6,
        color: active ? "var(--fgColor-default, #e6edf3)" : "var(--fgColor-muted, #848d97)",
        background: active ? "var(--bgColor-neutral-muted, #21262d)" : "transparent",
        textDecoration: "none",
      }}
    >
      {children}
    </Link>
  );
}
