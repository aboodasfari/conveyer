import { useEffect, useState } from "react";
import { Box, IconButton, Spinner } from "@primer/react";
import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import { api } from "../api";
import { RichText } from "./RichText";
import { TabPlaceholder } from "./TabPlaceholder";

/**
 * Renders the exact prompt the sidecar fed to the agent for this phase.
 * The sidecar saves it as `prompt.md` next to the phase's artifact before
 * the run starts. We render it as markdown so the section headers and code
 * fences look right.
 */
export function PromptView({ phaseId }: { phaseId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    // Tight cadence at first (file usually appears in <200ms), back off
    // to a poll-every-second cap for the long tail.
    const delayForAttempt = (n: number): number => (n < 5 ? 100 : n < 15 ? 300 : 1000);
    const MAX_ATTEMPTS = 200; // ~3 min total

    const tick = async () => {
      if (cancelled) return;
      attempts++;
      try {
        const s = await api.phasePromptGet(phaseId);
        if (cancelled) return;
        if (s) {
          setText(s);
          setLoading(false);
          return; // stop polling
        }
        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
      if (attempts < MAX_ATTEMPTS) {
        timer = window.setTimeout(tick, delayForAttempt(attempts));
      }
    };

    setLoading(true);
    setText(null);
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phaseId]);

  if (loading) return <Spinner size="small" />;
  if (!text) {
    return <TabPlaceholder title="The prompt sent to the agent will show up here once the phase starts." />;
  }

  return (
    <Box sx={{ position: "relative", height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Box sx={{ position: "absolute", top: 0, right: 8, zIndex: 1 }}>
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
