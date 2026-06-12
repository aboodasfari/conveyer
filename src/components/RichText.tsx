import { marked } from "marked";
import { useMemo } from "react";
import { Box, Text } from "@primer/react";

/**
 * ADO descriptions are typically HTML. Some teams paste markdown. `marked`
 * happily passes HTML through, so feeding either form to it produces the
 * right result. We render the output in a styled container.
 */
export function RichText({ content }: { content: string | null }) {
  const html = useMemo(() => {
    if (!content || !content.trim()) return "";
    try {
      return marked.parse(content, { async: false, breaks: true }) as string;
    } catch {
      return content;
    }
  }, [content]);

  if (!html) {
    return <Text sx={{ color: "fg.muted" }}>No description.</Text>;
  }
  return (
    <Box
      sx={{
        fontSize: 1,
        lineHeight: 1.5,
        "& *": { maxWidth: "100%" },
        "& img": { height: "auto" },
        "& pre": {
          bg: "canvas.subtle",
          p: 2,
          borderRadius: 1,
          overflowX: "auto",
        },
        "& code": {
          bg: "canvas.subtle",
          px: 1,
          borderRadius: 1,
          fontSize: 0,
        },
        "& pre > code": { bg: "transparent", px: 0 },
        "& blockquote": {
          borderLeftWidth: 3,
          borderLeftStyle: "solid",
          borderLeftColor: "border.muted",
          color: "fg.muted",
          pl: 2,
          ml: 0,
        },
        "& a": { color: "accent.fg" },
        "& h1, & h2, & h3": { mt: 3, mb: 2 },
        "& ul, & ol": { pl: 4 },
        "& > :first-child": { mt: 0 },
        "& > :last-child": { mb: 0 },
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
