import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Flash,
  FormControl,
  Heading,
  Radio,
  RadioGroup,
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

type Section = "sources" | "gates" | "appearance";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "gates", label: "Phase gates" },
  { id: "appearance", label: "Appearance" },
];

export function Settings() {
  const [section, setSection] = useState<Section>("sources");

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 4 }}>
      <Box>
        <Heading as="h1" sx={{ fontSize: 4, mb: 3 }}>Settings</Heading>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              style={{
                textAlign: "left",
                padding: "6px 10px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 14,
                background:
                  section === s.id ? "var(--bgColor-neutral-muted)" : "transparent",
                color: "var(--fgColor-default)",
              }}
            >
              {s.label}
            </button>
          ))}
        </Box>
      </Box>
      <Box>
        {section === "sources" && <SourcesSection />}
        {section === "gates" && <GatesSection />}
        {section === "appearance" && <AppearanceSection />}
      </Box>
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

  const load = async () => {
    try {
      setSources(await api.sourcesList());
    } catch (e) {
      setError(String(e));
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
      setError(String(e));
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Heading as="h2" sx={{ fontSize: 2 }}>Sources</Heading>
        <Button leadingVisual={PlusIcon} variant="primary" onClick={() => setAddOpen(true)}>
          Add source
        </Button>
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

  // form state
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
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={step === "kind" ? "Add source" : "Configure Azure DevOps source"}
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
              {busy ? "Testing & saving…" : "Add"}
            </Button>
          </>
        )
      }
    >
      {step === "kind" ? (
        <FormControl>
          <FormControl.Label>Source kind</FormControl.Label>
          <RadioGroup name="src-kind" onChange={(v) => setKind(v as "ado")}>
            <FormControl>
              <Radio value="ado" checked={kind === "ado"} />
              <FormControl.Label>Azure DevOps</FormControl.Label>
              <FormControl.Caption>
                Pulls work items assigned to you via WIQL.
              </FormControl.Caption>
            </FormControl>
          </RadioGroup>
        </FormControl>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {error && <Flash variant="danger">{error}</Flash>}
          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 }}>
            <FormControl>
              <FormControl.Label>Name</FormControl.Label>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="msazure-aks" />
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
/*                                Phase gates                                 */
/* -------------------------------------------------------------------------- */

function GatesSection() {
  const [gates, setGates] = useState<Gate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setGates(await api.gatesList());
    } catch (e) { setError(String(e)); } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const toggleGate = async (kind: string, current: number) => {
    const next = current === 0 ? 1 : 0;
    setGates((gs) => gs.map((g) => g.phase_kind === kind ? { ...g, auto_advance: next } : g));
    try {
      await api.gatesSet(kind, next === 1);
    } catch (e) {
      setError(String(e));
      setGates((gs) => gs.map((g) => g.phase_kind === kind ? { ...g, auto_advance: current } : g));
    }
  };

  const visibleKinds = useMemo(() => PHASE_KINDS.filter((k) => k !== "submit"), []);

  if (loading) return <Spinner />;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box>
        <Heading as="h2" sx={{ fontSize: 2 }}>Phase gates</Heading>
        <Text sx={{ color: "fg.muted", fontSize: 1 }}>
          Phases set to auto-advance proceed without waiting for your approval.
          Submit is terminal so it has no gate.
        </Text>
      </Box>
      {error && <Flash variant="danger">{error}</Flash>}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {visibleKinds.map((k) => {
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
              <Text id={labelId} sx={{ textTransform: "capitalize" }}>
                {k}{" "}
                <Text sx={{ color: "fg.muted", fontSize: 0 }}>
                  · {on ? "auto-advance" : "wait for me"}
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
      <FormControl>
        <FormControl.Label>Theme</FormControl.Label>
        <RadioGroup name="theme" onChange={(v) => setMode(v as "day" | "night")}>
          <FormControl>
            <Radio value="night" checked={mode === "night"} />
            <FormControl.Label>Dark</FormControl.Label>
          </FormControl>
          <FormControl>
            <Radio value="day" checked={mode === "day"} />
            <FormControl.Label>Light</FormControl.Label>
          </FormControl>
        </RadioGroup>
      </FormControl>
    </Box>
  );
}
