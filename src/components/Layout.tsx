import { Box, Header, IconButton } from "@primer/react";
import { GearIcon, HomeIcon } from "@primer/octicons-react";
import { Link, Outlet, useNavigate } from "react-router-dom";

export function Layout() {
  const nav = useNavigate();
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
          <IconButton
            aria-label="Dashboard"
            icon={HomeIcon}
            variant="invisible"
            onClick={() => nav("/")}
          />
        </Header.Item>
        <Header.Item>
          <IconButton
            aria-label="Settings"
            icon={GearIcon}
            variant="invisible"
            onClick={() => nav("/settings")}
          />
        </Header.Item>
      </Header>
      <Box as="main" sx={{ p: 4, flex: 1, maxWidth: 1200, mx: "auto", width: "100%" }}>
        <Outlet />
      </Box>
    </Box>
  );
}
