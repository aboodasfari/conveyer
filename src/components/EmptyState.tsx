import { Box, Heading, Text } from "@primer/react";
import { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <Box
      sx={{
        textAlign: "center",
        py: 6,
        px: 3,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: "border.default",
        borderRadius: 2,
      }}
    >
      <Heading as="h3" sx={{ fontSize: 2, mb: 2 }}>
        {title}
      </Heading>
      {body && <Text sx={{ color: "fg.muted", display: "block", mb: 3 }}>{body}</Text>}
      {action}
    </Box>
  );
}
