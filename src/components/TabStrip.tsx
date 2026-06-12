import { Box } from "@primer/react";

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ size?: number }>;
}

/**
 * Simple Primer-styled underline tab strip. We roll this in-house because
 * Primer's UnderlineNav has inherent left padding on the strip that looks
 * awkward when it isn't wrapping a full-width header.
 */
export function TabStrip<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; icon?: React.ComponentType<{ size?: number }> }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <Box
      role="tablist"
      sx={{
        display: "flex",
        gap: 1,
        borderBottomWidth: 1,
        borderBottomStyle: "solid",
        borderBottomColor: "border.default",
      }}
    >
      {tabs.map((t) => {
        const isActive = t.id === active;
        const Icon = t.icon;
        return (
          <Box
            key={t.id}
            as="button"
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              px: 3,
              py: 2,
              fontSize: 1,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? "fg.default" : "fg.muted",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              userSelect: "none",
              borderBottomWidth: 2,
              borderBottomStyle: "solid",
              borderBottomColor: isActive ? "accent.fg" : "transparent",
              mb: "-1px",
              transition: "color 80ms, border-color 80ms",
              "&:hover": { color: "fg.default" },
            }}
          >
            {Icon && <Icon size={16} />}
            {t.label}
          </Box>
        );
      })}
    </Box>
  );
}
