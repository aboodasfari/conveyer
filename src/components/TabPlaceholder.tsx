import { Box, Text } from "@primer/react";

/**
 * Standard placeholder used for empty tab content (no commits yet, no
 * artifact yet, etc.). Centered, muted, optional subtitle. Keep the
 * copy short and the headline informative — "X will show up here once Y".
 */
export function TabPlaceholder({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        py: 6,
        flex: 1,
        minHeight: 0,
        color: "fg.muted",
      }}
    >
      <Text sx={{ fontSize: 1 }}>{title}</Text>
      {subtitle && <Text sx={{ fontSize: 0 }}>{subtitle}</Text>}
    </Box>
  );
}
