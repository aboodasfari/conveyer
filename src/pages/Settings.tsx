import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Flash,
  FormControl,
  Heading,
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
  PHASE_KINDS,
  Source,
} from "../types";
import { Modal } from "../components/Modal";
import { useColorMode } from "../theme";
import { loadRefreshInterval, saveRefreshInterval } from "../autoRefresh";
import { formatError } from "../errors";

type Section = "sources" | "execution" | "appearance";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "execution", label: "Execution" },
  { id: "appearance", label: "Appearance" },
];

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Settings() {
  const [section, setSection] = useState<Section>("sources");

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 4 }}>
      <Box>
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
      </Box>
      <Box>
        {section === "sources" && <SourcesSection />}
        {section === "execution" && <ExecutionSection />}
        {section === "appearance" && <AppearanceSection />}
      </Box>
    </Box>
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
      setSources(s);
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
      <Box>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 3 }}>
          <Heading as="h2" sx={{ fontSize: 2 }}>Sources</Heading>
          <Box sx={{ display: "flex", gap: 2 }}>
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
            <Button leadingVisual={PlusIcon} variant="primary" onClick={() => setAddOpen(true)}>
              Add Source
            </Button>
          </Box>
        </Box>
        {error && <Flash variant="danger">{error}</Flash>}
        {loading ? (
          <Spinner />
        ) : sources.length === 0 ? (
          <Text sx={{ color: "fg.muted" }}>
            No sources yet. Add one to start discovering tasks.
          </Text>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {sources.map((s) => <SourceRow key={s.id} source={s} onDelete={() => onDelete(s.id)} />)}
          </Box>
        )}
      </Box>

      <Box>
        <Heading as="h3" sx={{ fontSize: 1, mb: 1 }}>Auto-refresh</Heading>
        <Text sx={{ color: "fg.muted", fontSize: 1, display: "block", mb: 2 }}>
          How often Conveyer polls your sources for new and updated tasks.
        </Text>
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
      </Box>

      <AddSourceModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => { void load(); setAddOpen(false); }}
      />
    </Box>
  );
}

function SourceRow({ source, onDelete }: { source: Source; onDelete: () => void }) {
  let cfg: AdoSourceConfig | null = null;
  try { cfg = JSON.parse(source.config_json); } catch { /* noop */ }
  const auth = source.auth_kind === "entra" ? "SSO (az)" : `PAT env: ${source.pat_env}`;
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
        {cfg && (
          <Text sx={{ display: "block", color: "fg.muted", fontSize: 0 }}>
            {cfg.org} / {cfg.project}{cfg.team ? ` / ${cfg.team}` : ""} · {auth}
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
  const [kind, setKind] = useState<"ado">("ado");

  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [team, setTeam] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("entra");
  const [patEnv, setPatEnv] = useState("ADO_PAT");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep("kind");
    setOrg(""); setProject(""); setTeam(""); setName("");
    setAuthKind("entra"); setPatEnv("ADO_PAT");
    setError(null);
  };

  const close = () => { reset(); onClose(); };

  const submit = async () => {
    setError(null); setBusy(true);
    try {
      const cfg: AdoSourceConfig = { org, project, team: team || undefined };
      const input = {
        kind, name: name || `${org}/${project}`,
        config_json: JSON.stringify(cfg),
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

  return (
    <Modal
      open={open}
      onClose={close}
      title={step === "kind" ? "Add Source" : "Configure Azure DevOps Source"}
      error={step === "form" ? error : null}
      footer={
        step === "kind" ? (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => setStep("form")}>Next</Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep("kind")}>Back</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={!org || !project || busy}
            >
              {busy ? "Testing & Saving…" : "Add"}
            </Button>
          </>
        )
      }
    >
      {step === "kind" ? (
        <RadioGroup name="src-kind" onChange={(v) => setKind(v as "ado")}>
          <FormControl>
            <Radio value="ado" checked={kind === "ado"} />
            <FormControl.Label>Azure DevOps</FormControl.Label>
          </FormControl>
        </RadioGroup>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <FormControl>
            <FormControl.Label>Name</FormControl.Label>
            <TextInput
              block
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="msazure-aks"
            />
          </FormControl>
          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 }}>
            <FormControl required>
              <FormControl.Label>Organisation</FormControl.Label>
              <TextInput value={org} onChange={(e) => setOrg(e.target.value)} placeholder="msazure" />
            </FormControl>
            <FormControl required>
              <FormControl.Label>Project</FormControl.Label>
              <TextInput value={project} onChange={(e) => setProject(e.target.value)} placeholder="CloudNativeCompute" />
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [codebase, setCodebase] = useState<string>("");
  const [codebaseSaved, setCodebaseSaved] = useState<string>("");

  const load = async () => {
    try {
      const [g, cb] = await Promise.all([
        api.gatesList(),
        api.settingGet("codebase_path"),
      ]);
      setGates(g);
      setCodebase(cb ?? "");
      setCodebaseSaved(cb ?? "");
    } catch (e) { setError(formatError(e)); } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const toggleGate = async (kind: string, current: number) => {
    const next = current === 0 ? 1 : 0;
    setGates((gs) => gs.map((g) => g.phase_kind === kind ? { ...g, auto_advance: next } : g));
    try {
      await api.gatesSet(kind, next === 1);
    } catch (e) {
      setError(formatError(e));
      setGates((gs) => gs.map((g) => g.phase_kind === kind ? { ...g, auto_advance: current } : g));
    }
  };

  const commitCodebase = async () => {
    if (codebase === codebaseSaved) return;
    try {
      await api.settingSet("codebase_path", codebase);
      setCodebaseSaved(codebase);
    } catch (e) {
      setError(formatError(e));
      setCodebase(codebaseSaved);
    }
  };

  if (loading) return <Spinner />;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Heading as="h2" sx={{ fontSize: 2 }}>Execution</Heading>
      {error && <Flash variant="danger">{error}</Flash>}

      <Box>
        <Heading as="h3" sx={{ fontSize: 1, mb: 1 }}>Codebase Path</Heading>
        <Text sx={{ color: "fg.muted", fontSize: 1, display: "block", mb: 2 }}>
          Absolute path the Copilot agent runs in. Defaults to{" "}
          <code>~/code/conveyer-test-repo</code>.
        </Text>
        <TextInput
          block
          value={codebase}
          onChange={(e) => setCodebase(e.target.value)}
          onBlur={() => void commitCodebase()}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="/Users/you/code/rp"
          sx={{ maxWidth: 480 }}
        />
      </Box>

      <Box>
        <Heading as="h3" sx={{ fontSize: 1, mb: 1 }}>Phase Gates</Heading>
        <Text sx={{ color: "fg.muted", fontSize: 1 }}>
          After a phase finishes, auto-advance to the next phase. Turn off to
          pause for your approval before continuing.
        </Text>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, mt: 3 }}>
          {PHASE_KINDS.map((k) => {
            const g = gates.find((x) => x.phase_kind === k) ?? { phase_kind: k, auto_advance: 0 };
            const on = g.auto_advance === 1;
            const labelId = `gate-${k}`;
            return (
              <Box
                key={k}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  py: 2,
                  borderBottomWidth: 1,
                  borderBottomStyle: "solid",
                  borderBottomColor: "border.muted",
                }}
              >
                <Text id={labelId}>
                  {titleCase(k)}{" "}
                  <Text sx={{ color: "fg.muted", fontSize: 0 }}>
                    · {on ? "auto-advance after" : "wait for me after"}
                  </Text>
                </Text>
                <ToggleSwitch
                  checked={on}
                  onClick={() => toggleGate(k, g.auto_advance)}
                  aria-labelledby={labelId}
                  size="small"
                />
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Appearance                                  */
/* -------------------------------------------------------------------------- */

function AppearanceSection() {
  const { mode, setMode } = useColorMode();
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Heading as="h2" sx={{ fontSize: 2 }}>Appearance</Heading>
      <Box>
        <Text sx={{ display: "block", fontWeight: 600, mb: 2 }}>Theme</Text>
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
      </Box>
    </Box>
  );
}
