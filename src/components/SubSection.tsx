import { ReactNode } from "react";
import { Box, Heading, Text } from "@primer/react";

/**
 * Subsection treatment used across Settings: a labelled block separated
 * from siblings by a top border. The first subsection in a list naturally
 * has no separator above it (use `noBorder`).
 */
export function SubSection({
  title,
  description,
  actions,
  noBorder,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  noBorder?: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        pt: noBorder ? 0 : 4,
        borderTopWidth: noBorder ? 0 : 1,
        borderTopStyle: "solid",
        borderTopColor: "border.muted",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 3,
          mb: description ? 1 : 3,
        }}
      >
        <Heading as="h3" sx={{ fontSize: 1 }}>{title}</Heading>
        {actions}
      </Box>
      {description && (
        <Text sx={{ color: "fg.muted", fontSize: 1, display: "block", mb: 3 }}>
          {description}
        </Text>
      )}
      {children}
    </Box>
  );
}
