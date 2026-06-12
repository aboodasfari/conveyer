import { Box, Text } from "@primer/react";

/**
 * Coloured state chip for ADO work item states. Falls back to gray.
 */
const COLORS: Record<string, string> = {
  // bluish — new/proposed
  new: "#58a6ff",
  proposed: "#58a6ff",
  todo: "#58a6ff",
  // yellow — active/in progress
  active: "#d29922",
  "in progress": "#d29922",
  committed: "#d29922",
  // green — resolved/done
  done: "#3fb950",
  resolved: "#3fb950",
  closed: "#3fb950",
  completed: "#3fb950",
  // red — removed
  removed: "#f85149",
};

export function StateChip({ state }: { state: string }) {
  const key = state.toLowerCase().trim();
  const color = COLORS[key] ?? "#8b949e";
  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 1,
        fontSize: 0,
        color: "fg.muted",
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          bg: color,
          flexShrink: 0,
        }}
      />
      <Text>{state || "—"}</Text>
    </Box>
  );
}
