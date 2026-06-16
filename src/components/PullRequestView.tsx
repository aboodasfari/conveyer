import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Flash, Label, Link, Spinner, Text } from "@primer/react";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  GitPullRequestIcon,
  GitPullRequestDraftIcon,
  PersonIcon,
  XCircleIcon,
} from "@primer/octicons-react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { PrCheck, PullRequest } from "../types";
import { formatError } from "../errors";
import { TabPlaceholder } from "./TabPlaceholder";
import { RichText } from "./RichText";

type LabelVariant = "default" | "accent" | "success" | "danger" | "attention";

const STATUS_META: Record<string, { label: string; variant: LabelVariant }> = {
  draft: { label: "Draft", variant: "attention" },
  creating: { label: "Creating…", variant: "accent" },
  created: { label: "Created", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
};

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseChecks(json: string | null): PrCheck[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .map((c) => ({ name: String(c?.name ?? ""), status: String(c?.status ?? "") }))
      .filter((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * Submit-phase PR preview. The agent first DRAFTS a PR (status 'draft'); we
 * show it here as if it were the real PR. The user clicks "Create pull
 * request" to approve, the agent creates it (status 'creating' -> 'created'),
 * and we then surface the live number/url/checks.
 */
export function PullRequestView({ phaseId }: { phaseId: string }) {
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const row = await api.pullRequestForPhase(phaseId);
      setPr(row);
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [phaseId]);

  useEffect(() => {
    load();
    let un: UnlistenFn | undefined;
    listen<{ phase_id: string }>("pr_changed", (ev) => {
      if (ev.payload.phase_id === phaseId) load();
    }).then((f) => (un = f));
    return () => un?.();
  }, [phaseId, load]);

  const onCreate = useCallback(async () => {
    setCreating(true);
    setErr(null);
    try {
      await api.prCreate(phaseId);
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setCreating(false);
    }
  }, [phaseId]);

  const reviewers = useMemo(() => parseList(pr?.reviewers_json ?? null), [pr]);
  const workItems = useMemo(() => parseList(pr?.work_items_json ?? null), [pr]);
  const checks = useMemo(() => parseChecks(pr?.checks_json ?? null), [pr]);

  if (loading) {
    return (
      <Box sx={{ p: 4, display: "flex", justifyContent: "center" }}>
        <Spinner />
      </Box>
    );
  }

  if (!pr) {
    return (
      <TabPlaceholder
        title="No pull request proposed yet"
        subtitle="It will appear here once the submit phase runs."
      />
    );
  }

  const meta = STATUS_META[pr.status] ?? { label: pr.status, variant: "default" as LabelVariant };
  const isDraft = pr.status === "draft";
  const isCreating = pr.status === "creating" || creating;
  const isFailed = pr.status === "failed";

  return (
    <Box sx={{ overflowY: "auto", maxWidth: 820 }}>
      {/* Title row */}
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2, mb: 2 }}>
        <Box sx={{ color: isDraft ? "attention.fg" : "success.fg", mt: "2px" }}>
          {isDraft ? <GitPullRequestDraftIcon size={20} /> : <GitPullRequestIcon size={20} />}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Text sx={{ fontSize: 3, fontWeight: "bold", lineHeight: 1.25 }}>
            {pr.title || "Untitled pull request"}
            {pr.number != null && (
              <Text sx={{ color: "fg.muted", fontWeight: "normal" }}> #{pr.number}</Text>
            )}
          </Text>
        </Box>
        <Label variant={meta.variant}>{meta.label}</Label>
      </Box>

      {/* Branch -> branch */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 3, flexWrap: "wrap" }}>
        <Label variant="secondary">{pr.source_branch || "(this branch)"}</Label>
        <Box sx={{ color: "fg.muted" }}>
          <ArrowRightIcon />
        </Box>
        <Label variant="secondary">{pr.target_branch || "(default branch)"}</Label>
        {pr.url && (
          <Link href={pr.url} target="_blank" sx={{ ml: 2, fontSize: 1 }}>
            Open in browser
          </Link>
        )}
      </Box>

      {isFailed && pr.error && (
        <Flash variant="danger" sx={{ mb: 3 }}>
          {pr.error}
        </Flash>
      )}

      {/* Description */}
      <SectionLabel>Description</SectionLabel>
      <Box
        sx={{
          border: "1px solid",
          borderColor: "border.default",
          borderRadius: 2,
          p: 3,
          mb: 3,
          bg: "canvas.subtle",
        }}
      >
        <RichText content={pr.description} />
      </Box>

      {/* Reviewers / work items */}
      {(reviewers.length > 0 || workItems.length > 0) && (
        <Box sx={{ display: "flex", gap: 5, mb: 3, flexWrap: "wrap" }}>
          {reviewers.length > 0 && (
            <Box>
              <SectionLabel>Reviewers</SectionLabel>
              {reviewers.map((r) => (
                <Box key={r} sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: 1 }}>
                  <PersonIcon size={14} />
                  <Text>{r}</Text>
                </Box>
              ))}
            </Box>
          )}
          {workItems.length > 0 && (
            <Box>
              <SectionLabel>Work items</SectionLabel>
              {workItems.map((w) => (
                <Text key={w} sx={{ display: "block", fontSize: 1 }}>
                  {w}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      {/* Checks */}
      {checks.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <SectionLabel>Checks</SectionLabel>
          {checks.map((c) => (
            <Box
              key={c.name}
              sx={{ display: "flex", alignItems: "center", gap: 2, fontSize: 1, py: "2px" }}
            >
              <CheckStatusIcon status={c.status} />
              <Text>{c.name}</Text>
              <Text sx={{ color: "fg.muted" }}>{c.status}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Action */}
      {isDraft && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 3, mt: 2 }}>
          <Button variant="primary" onClick={onCreate} disabled={creating}>
            Create pull request
          </Button>
          <Text sx={{ color: "fg.muted", fontSize: 0 }}>
            Creates a draft PR on the remote and queues required checks.
          </Text>
        </Box>
      )}
      {isCreating && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 2 }}>
          <Spinner size="small" />
          <Text sx={{ color: "fg.muted" }}>Creating the pull request…</Text>
        </Box>
      )}
      {isFailed && (
        <Button variant="default" onClick={onCreate} disabled={creating} sx={{ mt: 2 }}>
          Retry create
        </Button>
      )}

      {err && (
        <Flash variant="danger" sx={{ mt: 3 }}>
          {err}
        </Flash>
      )}
    </Box>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      sx={{
        display: "block",
        fontSize: 0,
        fontWeight: "bold",
        color: "fg.muted",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        mb: 1,
      }}
    >
      {children}
    </Text>
  );
}

function CheckStatusIcon({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s.includes("pass") || s.includes("success") || s.includes("succeed")) {
    return (
      <Box sx={{ color: "success.fg" }}>
        <CheckCircleIcon size={14} />
      </Box>
    );
  }
  if (s.includes("fail") || s.includes("error") || s.includes("reject")) {
    return (
      <Box sx={{ color: "danger.fg" }}>
        <XCircleIcon size={14} />
      </Box>
    );
  }
  return (
    <Box sx={{ color: "attention.fg" }}>
      <Spinner size="small" />
    </Box>
  );
}
