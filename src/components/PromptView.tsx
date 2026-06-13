import { useEffect, useState } from "react";
import { Box, Spinner } from "@primer/react";
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
  const [lastError, setLastError] = useState<string | null>(null);

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
        setLastError(null);
        if (s) {
          setText(s);
          setLoading(false);
          return; // stop polling
        }
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("phase_prompt_get failed:", e);
        setLastError(String((e as Error)?.message ?? e));
        setLoading(false);
      }
      if (attempts < MAX_ATTEMPTS) {
        timer = window.setTimeout(tick, delayForAttempt(attempts));
      }
    };

    setLoading(true);
    setText(null);
    setLastError(null);
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phaseId]);

  if (loading) return <Spinner size="small" />;
  if (lastError && !text) {
    return (
      <TabPlaceholder
        title="Couldn't load the prompt."
        subtitle={lastError}
      />
    );
  }
  if (!text) {
    return <TabPlaceholder title="The prompt sent to the agent will show up here once the phase starts." />;
  }

  return (
    <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", pr: 2 }}>
      <RichText content={text} />
    </Box>
  );
}
