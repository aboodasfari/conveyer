import { useCallback, useEffect, useState } from "react";
import { Box, IconButton, Spinner, Text } from "@primer/react";
import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import { api } from "../api";
import { RichText } from "./RichText";

/**
 * Renders the exact prompt the sidecar fed to the agent for this phase.
 * The sidecar saves it as `prompt.md` next to the phase's artifact before
 * the run starts. We render it as markdown so the section headers and code
 * fences look right.
 */
export function PromptView({ phaseId }: { phaseId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setText(await api.phasePromptGet(phaseId));
    } finally {
      setLoading(false);
    }
  }, [phaseId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <Spinner size="small" />
      </Box>
    );
  }
  if (!text) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, py: 6, color: "fg.muted" }}>
        <Text>No prompt captured yet.</Text>
        <Text sx={{ fontSize: 0 }}>
          The Prompt tab populates once the phase has run at least once.
        </Text>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, gap: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <Text sx={{ fontSize: 0, color: "fg.muted" }}>
          Edit the phase's prompt template under <Box as="code" sx={{ fontFamily: "mono", bg: "canvas.subtle", px: 1, borderRadius: 1 }}>prompts/</Box> in the repo.
        </Text>
        <CopyButton text={text} />
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pr: 2 }}>
        <RichText content={text} />
      </Box>
    </Box>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      aria-label={copied ? "Copied!" : "Copy prompt"}
      title={copied ? "Copied!" : "Copy prompt"}
      icon={copied ? CheckIcon : CopyIcon}
      variant="invisible"
      size="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard write can fail under restricted contexts.
        }
      }}
    />
  );
}
