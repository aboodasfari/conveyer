import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Box,
  Button,
  Flash,
  FormControl,
  Heading,
  IconButton,
  Radio,
  RadioGroup,
  SegmentedControl,
  Spinner,
  Text,
  TextInput,
  ToggleSwitch,
} from "@primer/react";
import { PlusIcon, TrashIcon } from "@primer/octicons-react";
import { api } from "../api";
import {
  AdoSourceConfig,
  AuthKind,
  Gate,
  GithubSourceConfig,
  PHASE_KINDS,
  Source,
  Workspace,
} from "../types";
import { Modal } from "../components/Modal";
import { ModelDropdown, ModelInfo } from "../components/ModelDropdown";
import { ReasoningDropdown, REASONING_LABEL } from "../components/ReasoningDropdown";
import { SubSection } from "../components/SubSection";
import { WorkspacePathInput } from "../components/WorkspacePathInput";
import { useColorMode } from "../theme";
import { loadRefreshInterval, saveRefreshInterval } from "../autoRefresh";
import { loadModels } from "../modelsCache";
import { formatError } from "../errors";

type Section = "sources" | "execution" | "notifications" | "appearance";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "execution", label: "Execution" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
];

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Settings() {
  const [section, setSection] = useState<Section>("sources");

  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 4,
        // Header (49 incl. 1px border) + main vertical padding from p: 4
        // (Primer's space[4] = 24px each side = 48 total) = 97. Match
        // exactly so the grid fills available space without producing an
        // outer scrollbar or leaving slack below the version label.
        height: "calc(100vh - 97px)",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          py: 1,
        }}
      >
        <Heading as="h1" sx={{ fontSize: 4, mb: 3 }}>Settings</Heading>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {SECTIONS.map((s) => (
            <SidebarLink
              key={s.id}
              label={s.label}
              active={section === s.id}
              onClick={() => setSection(s.id)}
            />
          ))}
        </Box>
        <Box sx={{ flex: 1 }} />
        <VersionFooter />
      </Box>
      <Box sx={{ overflowY: "auto", minHeight: 0, pr: 2 }}>
        {section === "sources" && <SourcesSection />}
        {section === "execution" && <ExecutionSection />}
        {section === "notifications" && <NotificationsSection />}
        {section === "appearance" && <AppearanceSection />}
      </Box>
    </Box>
  );
}

/** Tiny app version label pinned to the bottom-left of the Settings sidebar.
 *  Reads the runtime version from Tauri so it always matches what's installed.
 *  Only rendered when the call resolves (silently hidden in non-Tauri dev). */
function VersionFooter() {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setV).catch(() => {});
  }, []);
  if (!v) return null;
  return (
    <Text
      sx={{
        color: "fg.muted",
        fontSize: 0,
        fontVariantNumeric: "tabular-nums",
        userSelect: "none",
        mt: 3,
        px: 2,
      }}
    >
      v{v}
    </Text>
  );
}

function SidebarLink({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      as="button"
      onClick={onClick}
      type="button"
      sx={{
        textAlign: "left",
        px: 2,
        py: "6px",
        fontSize: 1,
        borderRadius: 2,
        border: "none",
        cursor: "pointer",
        color: active ? "fg.default" : "fg.muted",
        bg: active ? "neutral.muted" : "transparent",
        fontWeight: active ? 600 : 400,
        transition: "background-color 80ms",
        "&:hover": {
          bg: active ? "neutral.muted" : "neutral.subtle",
          color: "fg.default",
        },
      }}
    >
      {label}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Sources                                   */
/* -------------------------------------------------------------------------- */

function SourcesSection() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [intervalMin, setIntervalMin] = useState<number>(30);
  const [intervalDraft, setIntervalDraft] = useState<string>("30");

  const load = async () => {
    try {
      const [s, i] = await Promise.all([api.sourcesList(), loadRefreshInterval()]);
      // 'local' is a built-in singleton powering the New task flow —
      // implementation detail, not something the user adds or manages.
      setSources(s.filter((src) => src.kind !== "local"));
      setIntervalMin(i);
      setIntervalDraft(String(i));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const onDelete = async (id: string) => {
    try {
      await api.sourceDelete(id);
      await load();
    } catch (e) {
      setError(formatError(e));
    }
  };

  // Persist the interval on blur or Enter — autosave avoids an extra click.
  // Falls back to the last good value if the input isn't a positive number.
  const commitInterval = async () => {
    const n = parseInt(intervalDraft, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setIntervalDraft(String(intervalMin));
      return;
    }
    if (n === intervalMin) return;
    try {
      await saveRefreshInterval(n);
      setIntervalMin(n);
    } catch (e) {
      setError(formatError(e));
      setIntervalDraft(String(intervalMin));
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Heading as="h2" sx={{ fontSize: 2 }}>Sources</Heading>
      </Box>

      {error && <Flash variant="danger">{error}</Flash>}

      <SubSection
        title="Configured sources"
        description="Where Conveyer pulls tasks from."
        noBorder
        actions={
          <Box sx={{ display: "flex", gap: 2 }}>
            {import.meta.env.DEV && (
              <Button
                onClick={async () => {
                  try {
                    await api.tasksSeedDemo();
                    await load();
                  } catch (e) { setError(formatError(e)); }
                }}
              >
                Seed Demo Data
              </Button>
            )}
            <Button leadingVisual={PlusIcon} variant="primary" onClick={() => setAddOpen(true)}>
              Add Source
            </Button>
          </Box>
        }
      >
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 160 }}>
            <Spinner />
          </Box>
        ) : sources.length === 0 ? (
          <Text sx={{ color: "fg.muted" }}>
            No sources yet. Add one to start discovering tasks.
          </Text>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {sources.map((s) => <SourceRow key={s.id} source={s} onDelete={() => onDelete(s.id)} />)}
          </Box>
        )}
      </SubSection>

      <SubSection
        title="Auto-refresh"
        description="How often Conveyer polls your sources for new and updated tasks."
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <TextInput
            type="number"
            value={intervalDraft}
            onChange={(e) => setIntervalDraft(e.target.value)}
            onBlur={() => void commitInterval()}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            sx={{ width: 100 }}
            min={1}
          />
          <Text sx={{ color: "fg.muted" }}>minutes</Text>
        </Box>
      </SubSection>

      <AddSourceModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => { void load(); setAddOpen(false); }}
      />
    </Box>
  );
}

function SourceRow({ source, onDelete }: { source: Source; onDelete: () => void }) {
  let detail = "";
  try {
    if (source.kind === "github") {
      const cfg = JSON.parse(source.config_json) as GithubSourceConfig;
      const scope = cfg.repo ? `${cfg.owner}/${cfg.repo}` : cfg.owner;
      const auth = source.auth_kind === "pat" ? `PAT env: ${source.pat_env}` : "GitHub CLI";
      const host = cfg.host && cfg.host !== "github.com" ? `${cfg.host} · ` : "";
      detail = `${host}${scope} · ${auth}`;
    } else {
      const cfg = JSON.parse(source.config_json) as AdoSourceConfig;
      const auth = source.auth_kind === "entra" ? "SSO (az)" : `PAT env: ${source.pat_env}`;
      detail = `${cfg.org} / ${cfg.project}${cfg.team ? ` / ${cfg.team}` : ""} · ${auth}`;
    }
  } catch { /* noop */ }
  const kindLabel = source.kind === "github" ? "GitHub" : "Azure DevOps";
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        p: 3,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.muted",
        borderRadius: 2,
      }}
    >
      <Box>
        <Text sx={{ fontWeight: "bold" }}>{source.name}</Text>
        {detail && (
          <Text sx={{ display: "block", color: "fg.muted", fontSize: 0 }}>
            {kindLabel} · {detail}
          </Text>
        )}
      </Box>
      <Button leadingVisual={TrashIcon} variant="danger" onClick={onDelete}>
        Delete
      </Button>
    </Box>
  );
}

function AddSourceModal({
  open, onClose, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [step, setStep] = useState<"kind" | "form">("kind");
  const [kind, setKind] = useState<"ado" | "github">("ado");

  // ADO fields
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [team, setTeam] = useState("");
  // GitHub fields
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [ghHost, setGhHost] = useState("");
  // Shared
  const [authKind, setAuthKind] = useState<AuthKind>("entra");
  const [patEnv, setPatEnv] = useState("ADO_PAT");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep("kind");
    setKind("ado");
    setOrg(""); setProject(""); setTeam(""); setName("");
    setOwner(""); setRepo(""); setGhHost("");
    setAuthKind("entra"); setPatEnv("ADO_PAT");
    setError(null);
  };

  const close = () => { reset(); onClose(); };

  // Auth defaults differ per kind: ADO uses Entra(az), GitHub uses the gh CLI.
  const goToForm = () => {
    if (kind === "github") {
      setAuthKind("gh" as AuthKind);
      setPatEnv("GITHUB_TOKEN");
    } else {
      setAuthKind("entra");
      setPatEnv("ADO_PAT");
    }
    setStep("form");
  };

  const submit = async () => {
    setError(null); setBusy(true);
    try {
      const config_json =
        kind === "github"
          ? JSON.stringify({ owner, repo: repo || undefined, host: ghHost.trim() || undefined } as GithubSourceConfig)
          : JSON.stringify({ org, project, team: team || undefined } as AdoSourceConfig);
      const defaultName =
        kind === "github" ? (repo ? `${owner}/${repo}` : owner) : `${org}/${project}`;
      const input = {
        kind, name: name || defaultName,
        config_json,
        pat_env: patEnv, enabled: true,
        auth_kind: authKind, az_account: "",
      };
      await api.sourceTest(input);
      await api.sourceUpsert(input);
      reset();
      onAdded();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = kind === "github" ? !!owner : !!org && !!project;

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        step === "kind"
          ? "Add Source"
          : kind === "github"
            ? "Configure GitHub Source"
            : "Configure Azure DevOps Source"
      }
      error={step === "form" ? error : null}
      footer={
        step === "kind" ? (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={goToForm}>Next</Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep("kind")}>Back</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={!canSubmit || busy}
            >
              {busy ? "Testing & Saving…" : "Add"}
            </Button>
          </>
        )
      }
    >
      {step === "kind" ? (
        <RadioGroup name="src-kind" onChange={(v) => setKind(v as "ado" | "github")}>
          <FormControl>
            <Radio value="ado" checked={kind === "ado"} />
            <FormControl.Label>Azure DevOps</FormControl.Label>
          </FormControl>
          <FormControl>
            <Radio value="github" checked={kind === "github"} />
            <FormControl.Label>GitHub</FormControl.Label>
          </FormControl>
        </RadioGroup>
      ) : kind === "github" ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <FormControl>
            <FormControl.Label>Name</FormControl.Label>
            <TextInput
              block
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My GitHub issues"
            />
          </FormControl>
          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 }}>
            <FormControl required>
              <FormControl.Label>Owner</FormControl.Label>
              <TextInput value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="org-or-user" />
            </FormControl>
            <FormControl>
              <FormControl.Label>Repo (optional)</FormControl.Label>
              <TextInput value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="name (blank = all)" />
            </FormControl>
            <FormControl>
              <FormControl.Label>Host (optional)</FormControl.Label>
              <TextInput value={ghHost} onChange={(e) => setGhHost(e.target.value)} placeholder="github.com" />
            </FormControl>
            <FormControl>
              <FormControl.Label>Auth</FormControl.Label>
              <RadioGroup name="gh-auth-kind" onChange={(v) => setAuthKind(v as AuthKind)}>
                <FormControl>
                  <Radio value="gh" checked={authKind === ("gh" as AuthKind)} />
                  <FormControl.Label>GitHub CLI (via `gh`)</FormControl.Label>
                </FormControl>
                <FormControl>
                  <Radio value="pat" checked={authKind === "pat"} />
                  <FormControl.Label>Personal access token</FormControl.Label>
                </FormControl>
              </RadioGroup>
            </FormControl>
            {authKind === "pat" && (
              <FormControl>
                <FormControl.Label>PAT env var</FormControl.Label>
                <TextInput value={patEnv} onChange={(e) => setPatEnv(e.target.value)} />
                <FormControl.Caption>
                  Conveyer reads this env var at refresh time.
                </FormControl.Caption>
              </FormControl>
            )}
          </Box>
        </Box>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <FormControl>
            <FormControl.Label>Name</FormControl.Label>
            <TextInput
              block
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My ADO board"
            />
          </FormControl>
          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 }}>
            <FormControl required>
              <FormControl.Label>Organisation</FormControl.Label>
              <TextInput value={org} onChange={(e) => setOrg(e.target.value)} placeholder="your-org" />
            </FormControl>
            <FormControl required>
              <FormControl.Label>Project</FormControl.Label>
              <TextInput value={project} onChange={(e) => setProject(e.target.value)} placeholder="your-project" />
            </FormControl>
            <FormControl>
              <FormControl.Label>Team (optional)</FormControl.Label>
              <TextInput value={team} onChange={(e) => setTeam(e.target.value)} />
            </FormControl>
            <FormControl>
              <FormControl.Label>Auth</FormControl.Label>
              <RadioGroup name="auth-kind" onChange={(v) => setAuthKind(v as AuthKind)}>
                <FormControl>
                  <Radio value="entra" checked={authKind === "entra"} />
                  <FormControl.Label>Entra SSO (via `az`)</FormControl.Label>
                </FormControl>
                <FormControl>
                  <Radio value="pat" checked={authKind === "pat"} />
                  <FormControl.Label>Personal access token</FormControl.Label>
                </FormControl>
              </RadioGroup>
            </FormControl>
            {authKind === "pat" && (
              <FormControl>
                <FormControl.Label>PAT env var</FormControl.Label>
                <TextInput value={patEnv} onChange={(e) => setPatEnv(e.target.value)} />
                <FormControl.Caption>
                  Conveyer reads this env var at refresh time.
                </FormControl.Caption>
              </FormControl>
            )}
          </Box>
        </Box>
      )}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Execution                                  */
/* -------------------------------------------------------------------------- */

function ExecutionSection() {
  const [gates, setGates] = useState<Gate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelDefault, setModelDefault] = useState<string>("");
  const [modelPhase, setModelPhase] = useState<Record<string, string>>({});
  const [reasoningDefault, setReasoningDefault] = useState<string>("");
  const [reasoningPhase, setReasoningPhase] = useState<Record<string, string>>({});
  const [submitEnabled, setSubmitEnabled] = useState<boolean>(true);
  const [useWorktree, setUseWorktree] = useState<boolean>(true);
  const [branchAlias, setBranchAlias] = useState<string>("");

  // Fast local-DB lookups: gates, workspaces, model/reasoning settings.
  // These should render the section immediately rather than block on the
  // slow Copilot SDK model listing.
  useEffect(() => {
    void (async () => {
      try {
        const [g, ws, mDef, rDef, submitV, baV, wtV, ...rest] = await Promise.all([
          api.gatesList(),
          api.workspacesList(),
          api.settingGet("model_default"),
          api.settingGet("reasoning_default"),
          api.settingGet("phase_submit_enabled"),
          api.settingGet("branch_alias"),
          api.settingGet("use_worktree"),
          ...PHASE_KINDS.map((k) => api.settingGet(`model_${k}`)),
          ...PHASE_KINDS.map((k) => api.settingGet(`reasoning_${k}`)),
        ]);
        const mPhaseVals = rest.slice(0, PHASE_KINDS.length);
        const rPhaseVals = rest.slice(PHASE_KINDS.length);
        setGates(g);
        setWorkspaces(ws);
        setModelDefault(mDef ?? "");
        setReasoningDefault(rDef ?? "");
        setSubmitEnabled(submitV !== "0" && submitV?.toLowerCase() !== "false");
        setUseWorktree(wtV !== "0" && wtV?.toLowerCase() !== "false");
        setBranchAlias(baV ?? "");
        const mOver: Record<string, string> = {};
        const rOver: Record<string, string> = {};
        PHASE_KINDS.forEach((k, i) => {
          mOver[k] = mPhaseVals[i] ?? "";
          rOver[k] = rPhaseVals[i] ?? "";
        });
        setModelPhase(mOver);
        setReasoningPhase(rOver);
      } catch (e) { setError(formatError(e)); }
    })();
  }, []);

  // Models come from a slow SDK call. Load separately so the rest of the
  // section renders immediately while only the Models subsection spins.
  useEffect(() => {
    void (async () => {
      try {
        setModels(await loadModels());
      } catch (e) {
        setError(formatError(e));
      } finally {
        setModelsLoading(false);
      }
    })();
  }, []);

  const toggleGate = async (kind: string, current: number) => {
    const next = current === 0 ? 1 : 0;
    // Upsert: virtual gates like `review_rewind` may not be in the list
    // yet (they're created on first toggle), so a plain map() would drop
    // the change. Insert the row if it's missing.
    setGates((gs) =>
      gs.some((g) => g.phase_kind === kind)
        ? gs.map((g) => (g.phase_kind === kind ? { ...g, auto_advance: next } : g))
        : [...gs, { phase_kind: kind, auto_advance: next }],
    );
    try {
      await api.gatesSet(kind, next === 1);
    } catch (e) {
      setError(formatError(e));
      setGates((gs) => gs.map((g) => g.phase_kind === kind ? { ...g, auto_advance: current } : g));
    }
  };

  const upsertWorkspace = async (id: number | null, name: string, path: string) => {
    try {
      const w = await api.workspaceUpsert(id, name, path);
      setWorkspaces((ws) => {
        const idx = ws.findIndex((x) => x.id === w.id);
        if (idx >= 0) {
          const next = ws.slice();
          next[idx] = w;
          return next;
        }
        return [...ws, w].sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (e) {
      setError(formatError(e));
    }
  };

  const deleteWorkspace = async (id: number) => {
    try {
      await api.workspaceDelete(id);
      setWorkspaces((ws) => ws.filter((w) => w.id !== id));
    } catch (e) {
      setError(formatError(e));
    }
  };

  const toggleSubmit = async () => {
    const next = !submitEnabled;
    setSubmitEnabled(next);
    try {
      await api.settingSet("phase_submit_enabled", next ? "1" : "0");
    } catch (e) {
      setError(formatError(e));
      setSubmitEnabled(!next);
    }
  };

  const toggleWorktree = async () => {
    const next = !useWorktree;
    setUseWorktree(next);
    try {
      await api.settingSet("use_worktree", next ? "1" : "0");
    } catch (e) {
      setError(formatError(e));
      setUseWorktree(!next);
    }
  };

  const saveBranchAlias = async () => {
    try {
      await api.settingSet("branch_alias", branchAlias.trim());
    } catch (e) {
      setError(formatError(e));
    }
  };

  const setModel = async (key: string, value: string) => {
    try {
      await api.settingSet(key, value);
    } catch (e) {
      setError(formatError(e));
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Heading as="h2" sx={{ fontSize: 2 }}>Execution</Heading>
      {error && <Flash variant="danger">{error}</Flash>}

      <SubSection
        title="Workspaces"
        description={<>Named code repos Conveyer can run agents in. Each task can pin one explicitly, otherwise the prompt lists all of these so the agent picks the best match.</>}
        noBorder
      >
        <WorkspaceList
          workspaces={workspaces}
          onUpsert={upsertWorkspace}
          onDelete={deleteWorkspace}
        />
      </SubSection>

      <SubSection
        title="Branch naming"
        description={<>Prefix for the branches Conveyer creates, as <code>&lt;alias&gt;/&lt;task&gt;</code>. Leave blank to derive it from your git identity (falling back to <code>conveyer</code>).</>}
      >
        <FormControl>
          <FormControl.Label>Branch alias</FormControl.Label>
          <TextInput
            value={branchAlias}
            onChange={(e) => setBranchAlias(e.target.value)}
            onBlur={saveBranchAlias}
            placeholder="(from git identity)"
            sx={{ maxWidth: 320 }}
          />
        </FormControl>
      </SubSection>

      <SubSection
        title="Models"
        description={
          <>
            Default model used by every phase, with optional per-phase overrides.
            {!modelsLoading && models.length === 0 && " Could not reach the Copilot SDK to list models — make sure `copilot` is signed in."}
          </>
        }
      >
        {modelsLoading ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, color: "fg.muted" }}>
            <Spinner size="small" />
            <Text sx={{ fontSize: 0 }}>Loading models from Copilot…</Text>
          </Box>
        ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <ModelChooser
            label="Default"
            models={models}
            model={modelDefault}
            effectiveModelId={modelDefault}
            reasoning={reasoningDefault}
            effectiveReasoning={reasoningDefault}
            inheritLabel="Pick a model…"
            allowInheritModel={false}
            onModelChange={(v) => {
              setModelDefault(v);
              void setModel("model_default", v);
              // Changing the model invalidates the reasoning value; reset.
              setReasoningDefault("");
              void setModel("reasoning_default", "");
            }}
            onReasoningChange={(v) => {
              setReasoningDefault(v);
              void setModel("reasoning_default", v);
            }}
          />
          {PHASE_KINDS.map((k) => {
            const phaseModelId = modelPhase[k] ?? "";
            const effectiveId = phaseModelId || modelDefault;
            const inherited = models.find((m) => m.id === effectiveId);
            const inheritLabel = !phaseModelId
              ? `Inherit · ${inherited?.name ?? modelDefault ?? "gpt-5.1"}`
              : "Inherit default";
            const phaseReasoning = reasoningPhase[k] ?? "";
            const effectiveReasoning = phaseReasoning ||
              reasoningDefault ||
              inherited?.default_reasoning_effort || "";
            return (
              <ModelChooser
                key={k}
                label={k.charAt(0).toUpperCase() + k.slice(1)}
                models={models}
                model={phaseModelId}
                effectiveModelId={effectiveId}
                reasoning={phaseReasoning}
                effectiveReasoning={effectiveReasoning}
                inheritLabel={inheritLabel}
                allowInheritModel
                onModelChange={(v) => {
                  setModelPhase((cur) => ({ ...cur, [k]: v }));
                  void setModel(`model_${k}`, v);
                  // Reset reasoning when model changes for this phase.
                  setReasoningPhase((cur) => ({ ...cur, [k]: "" }));
                  void setModel(`reasoning_${k}`, "");
                }}
                onReasoningChange={(v) => {
                  setReasoningPhase((cur) => ({ ...cur, [k]: v }));
                  void setModel(`reasoning_${k}`, v);
                }}
              />
            );
          })}
        </Box>
        )}
      </SubSection>

      <SubSection
        title="Run Defaults"
        description="Defaults applied to new runs. Each task can override these in its own Run settings."
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            py: 2,
          }}
        >
          <Text>
            Submit PR{" "}
            <Text sx={{ color: "fg.muted", fontSize: 0 }}>
              · {submitEnabled ? "runs end with opening a PR" : "runs end after review"}
            </Text>
          </Text>
          <ToggleSwitch
            checked={submitEnabled}
            onClick={toggleSubmit}
            aria-label="Submit PR"
            size="small"
          />
        </Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            py: 2,
            borderTopWidth: 1,
            borderTopStyle: "solid",
            borderTopColor: "border.subtle",
          }}
        >
          <Text>
            Worktrees{" "}
            <Text sx={{ color: "fg.muted", fontSize: 0 }}>
              · {useWorktree
                ? "each run gets its own git worktree (recommended)"
                : "runs use the workspace directly — current branch, in place"}
            </Text>
          </Text>
          <ToggleSwitch
            checked={useWorktree}
            onClick={toggleWorktree}
            aria-label="Use git worktrees"
            size="small"
          />
        </Box>
      </SubSection>

      <SubSection
        title="Phase Gates"
        description="Auto-advance after each phase, or pause for your input."
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {PHASE_KINDS.map((k) => {
            const g = gates.find((x) => x.phase_kind === k) ?? { phase_kind: k, auto_advance: 0 };
            const on = g.auto_advance === 1;
            const labelId = `gate-${k}`;
            const isReview = k === "review";

            if (isReview) {
              const approveGate = g;
              const approveOn = on;
              const rewindGate = gates.find((x) => x.phase_kind === "review_rewind")
                ?? { phase_kind: "review_rewind", auto_advance: 0 };
              const rewindOn = rewindGate.auto_advance === 1;
              return (
                <Box key={k}>
                  <Box sx={{ py: 2 }}>
                    <Text sx={{ fontWeight: "semibold" }}>Review</Text>
                  </Box>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      py: 2,
                      pl: 3,
                    }}
                  >
                    <Text id="gate-review-approve">
                      <Text sx={{ color: "fg.muted" }}>↳</Text>{" "}
                      When reviewer approves{" "}
                      <Text sx={{ color: "fg.muted", fontSize: 0 }}>
                        · {approveOn ? "auto-advance to next phase" : "wait for me"}
                      </Text>
                    </Text>
                    <ToggleSwitch
                      checked={approveOn}
                      onClick={() => toggleGate("review", approveGate.auto_advance)}
                      aria-labelledby="gate-review-approve"
                      size="small"
                    />
                  </Box>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      py: 2,
                      pl: 3,
                    }}
                  >
                    <Text id="gate-review-rewind">
                      <Text sx={{ color: "fg.muted" }}>↳</Text>{" "}
                      When reviewer requests changes{" "}
                      <Text sx={{ color: "fg.muted", fontSize: 0 }}>
                        · {rewindOn ? "auto-rewind to implementation" : "wait for me"}
                      </Text>
                    </Text>
                    <ToggleSwitch
                      checked={rewindOn}
                      onClick={() => toggleGate("review_rewind", rewindGate.auto_advance)}
                      aria-labelledby="gate-review-rewind"
                      size="small"
                    />
                  </Box>
                </Box>
              );
            }

            return (
              <Box key={k}>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    py: 2,
                  }}
                >
                  <Text id={labelId}>
                    {titleCase(k)}{" "}
                    <Text sx={{ color: "fg.muted", fontSize: 0 }}>
                      · {k === "submit"
                        ? on
                          ? "auto-create the PR after the agent drafts it"
                          : "show the PR preview and wait for me to create"
                        : on
                          ? "auto-advance after"
                          : "wait for me after"}
                    </Text>
                  </Text>
                  <ToggleSwitch
                    checked={on}
                    onClick={() => toggleGate(k, g.auto_advance)}
                    aria-labelledby={labelId}
                    size="small"
                  />
                </Box>
              </Box>
            );
          })}
        </Box>
      </SubSection>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Helpers                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row in the model picker: a label, the model dropdown, and a
 * reasoning-effort dropdown when the resolved model supports it.
 */
function ModelChooser({
  label,
  models,
  model,
  effectiveModelId,
  reasoning,
  effectiveReasoning,
  inheritLabel,
  allowInheritModel,
  onModelChange,
  onReasoningChange,
}: {
  label: string;
  models: ModelInfo[];
  model: string;
  /** Model id this row will actually run with — own value if set, else parent's. */
  effectiveModelId: string;
  reasoning: string;
  /** Reasoning value this row will actually run with — own → parent default → model default. */
  effectiveReasoning: string;
  inheritLabel: string;
  allowInheritModel: boolean;
  onModelChange: (v: string) => void;
  onReasoningChange: (v: string) => void;
}) {
  const effective = models.find((m) => m.id === effectiveModelId);
  const supported = effective?.supported_reasoning_efforts ?? [];
  // When inheriting reasoning, label with the actual value (e.g. "Inherit (Medium)").
  const inheritReasoningLabel = (() => {
    const eff = effectiveReasoning || effective?.default_reasoning_effort;
    if (!eff) return "Inherit";
    return `Inherit (${REASONING_LABEL[eff] ?? eff})`;
  })();

  return (
    <Box
      sx={{
        display: "grid",
        // 1fr column for the model picker so it shrinks; reasoning column
        // is fixed-width and won't overlap on long names.
        gridTemplateColumns: "120px minmax(0, 1fr) auto",
        gap: 3,
        alignItems: "center",
      }}
    >
      <Text sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</Text>
      <Box sx={{ minWidth: 0 }}>
        {models.length > 0 ? (
          <ModelDropdown
            value={model}
            models={models}
            onChange={onModelChange}
            allowInherit={allowInheritModel}
            inheritLabel={inheritLabel}
            width="100%"
          />
        ) : (
          <TextInput
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder={allowInheritModel ? "(inherit default)" : "gpt-5.1"}
            block
          />
        )}
      </Box>
      {supported.length > 0 ? (
        <ReasoningDropdown
          value={reasoning}
          supported={supported}
          defaultEffort={effective?.default_reasoning_effort}
          onChange={onReasoningChange}
          allowInherit
          inheritLabel={inheritReasoningLabel}
        />
      ) : (
        <Box sx={{ width: 180 }} aria-hidden />
      )}
    </Box>
  );
}

function AppearanceSection() {
  const { mode, setMode } = useColorMode();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Heading as="h2" sx={{ fontSize: 2 }}>Appearance</Heading>
      <SubSection
        title="Theme"
        description="Conveyer follows your selection across the app."
        noBorder
      >
        <SegmentedControl aria-label="Theme">
          <SegmentedControl.Button
            selected={mode === "night"}
            onClick={() => setMode("night")}
          >
            Dark
          </SegmentedControl.Button>
          <SegmentedControl.Button
            selected={mode === "day"}
            onClick={() => setMode("day")}
          >
            Light
          </SegmentedControl.Button>
        </SegmentedControl>
      </SubSection>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Workspace list                                */
/* -------------------------------------------------------------------------- */

/**
 * Compact CRUD for the workspaces list. Each existing row is editable inline
 * (commit on blur / Enter). A trailing "add row" lets the user create one.
 */
function WorkspaceList({
  workspaces,
  onUpsert,
  onDelete,
}: {
  workspaces: Workspace[];
  onUpsert: (id: number | null, name: string, path: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 720 }}>
      {workspaces.map((w) => (
        <WorkspaceRow key={w.id} workspace={w} onUpsert={onUpsert} onDelete={onDelete} />
      ))}
      <NewWorkspaceRow onUpsert={onUpsert} />
    </Box>
  );
}

function WorkspaceRow({
  workspace,
  onUpsert,
  onDelete,
}: {
  workspace: Workspace;
  onUpsert: (id: number | null, name: string, path: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [name, setName] = useState(workspace.name);
  const [path, setPath] = useState(workspace.path);

  const commit = () => {
    const n = name.trim();
    const p = path.trim();
    if (!n || !p) return;
    if (n === workspace.name && p === workspace.path) return;
    void onUpsert(workspace.id, n, p);
  };

  return (
    <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
      <TextInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        sx={{ width: 180 }}
        aria-label="Workspace name"
      />
      <Box sx={{ flex: 1 }}>
        <WorkspacePathInput
          value={path}
          onChange={setPath}
          onBlur={commit}
          onEnter={commit}
        />
      </Box>
      <IconButton
        aria-label="Delete workspace"
        title="Delete workspace"
        icon={TrashIcon}
        variant="invisible"
        onClick={() => void onDelete(workspace.id)}
      />
    </Box>
  );
}

function NewWorkspaceRow({
  onUpsert,
}: {
  onUpsert: (id: number | null, name: string, path: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const submit = async () => {
    const n = name.trim();
    const p = path.trim();
    if (!n || !p) return;
    await onUpsert(null, n, p);
    setName("");
    setPath("");
  };
  return (
    <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
      <TextInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        placeholder="Name"
        sx={{ width: 180 }}
        aria-label="New workspace name"
      />
      <Box sx={{ flex: 1 }}>
        <WorkspacePathInput value={path} onChange={setPath} onEnter={() => void submit()} />
      </Box>
      <Button
        leadingVisual={PlusIcon}
        onClick={() => void submit()}
        disabled={!name.trim() || !path.trim()}
      >
        Add
      </Button>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Notifications section                             */
/* -------------------------------------------------------------------------- */

function NotificationsSection() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<{ enabled: boolean; waiting: boolean; failed: boolean; newTask: boolean; taskFinished: boolean } | null>(null);

  const refresh = async () => {
    try {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      setGranted(await isPermissionGranted());
    } catch {
      setGranted(false);
    }
    try {
      const { loadNotifPrefs } = await import("../runNotifications");
      setPrefs(await loadNotifPrefs());
    } catch {
      setPrefs({ enabled: true, waiting: true, failed: true, newTask: true, taskFinished: true });
    }
  };

  useEffect(() => { void refresh(); }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const { requestPermission } = await import("@tauri-apps/plugin-notification");
      const res = await requestPermission();
      setGranted(res === "granted");
    } catch {
      setGranted(false);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (kind: "enabled" | "waiting" | "failed" | "newTask" | "taskFinished") => {
    if (!prefs) return;
    const next = { ...prefs, [kind]: !prefs[kind] };
    setPrefs(next);
    try {
      const { setNotifPref } = await import("../runNotifications");
      await setNotifPref(kind, next[kind]);
    } catch {
      setPrefs(prefs);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Heading as="h2" sx={{ fontSize: 2 }}>Notifications</Heading>

      {granted === false && (
        <SubSection title="Permission required" noBorder>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
            <Text sx={{ color: "fg.muted", fontSize: 1 }}>
              macOS hasn't granted Conveyer notification permission. If clicking Enable doesn't
              prompt, toggle it in System Settings → Notifications → Conveyer.
            </Text>
            <Button variant="primary" onClick={() => void enable()} disabled={busy}>
              {busy ? "Requesting…" : "Enable notifications"}
            </Button>
          </Box>
        </SubSection>
      )}

      {granted !== false && prefs && (
        <SubSection title="What to notify me about" noBorder>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <NotifToggle
              label="All notifications"
              on={prefs.enabled}
              onToggle={() => void toggle("enabled")}
            />
            <Box sx={{ borderTop: "1px solid", borderTopColor: "border.muted", mt: 1, pt: 2, display: "flex", flexDirection: "column", gap: 2 }}>
              <NotifToggle
                label="Waiting for approval"
                on={prefs.waiting}
                onToggle={() => void toggle("waiting")}
                disabled={!prefs.enabled}
              />
              <NotifToggle
                label="Phase failed"
                on={prefs.failed}
                onToggle={() => void toggle("failed")}
                disabled={!prefs.enabled}
              />
              <NotifToggle
                label="New task discovered"
                on={prefs.newTask}
                onToggle={() => void toggle("newTask")}
                disabled={!prefs.enabled}
              />
              <NotifToggle
                label="Task finished"
                on={prefs.taskFinished}
                onToggle={() => void toggle("taskFinished")}
                disabled={!prefs.enabled}
              />
            </Box>
          </Box>
        </SubSection>
      )}
    </Box>
  );
}

function NotifToggle({
  label,
  on,
  onToggle,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text>{label}</Text>
      <ToggleSwitch
        checked={on}
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
        aria-label={label}
        size="small"
      />
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
