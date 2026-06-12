import { ReactNode } from "react";
import { Box, Heading, Text } from "@primer/react";

/** Bordered card used to group related settings under a labelled section. */
export function SubSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        p: 4,
        bg: "canvas.default",
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
