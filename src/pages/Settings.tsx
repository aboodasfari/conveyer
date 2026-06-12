import { useEffect, useState } from "react";
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
import { TrashIcon } from "@primer/octicons-react";
import { api } from "../api";
import { AdoSourceConfig, AuthKind, Gate, PHASE_KINDS, Source } from "../types";

export function Settings() {
  const [sources, setSources] = useState<Source[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [team, setTeam] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("entra");
  const [patEnv, setPatEnv] = useState("ADO_PAT");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const [s, g] = await Promise.all([api.sourcesList(), api.gatesList()]);
      setSources(s);
      setGates(g);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addSource = async () => {
    setError(null);
    setSaved(null);
    setAdding(true);
    try {
      const cfg: AdoSourceConfig = { org, project, team: team || undefined };
      const input = {
        kind: "ado",
        name: name || `${org}/${project}`,
        config_json: JSON.stringify(cfg),
        pat_env: patEnv,
        enabled: true,
        auth_kind: authKind,
        az_account: "",
      };
      // Validate before saving so users see auth errors at the form, not on first refresh.
      await api.sourceTest(input);
      await api.sourceUpsert(input);
      setOrg(""); setProject(""); setTeam(""); setName("");
      setSaved("Source added and reachable.");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  };

  const deleteSource = async (id: string) => {
    try {
      await api.sourceDelete(id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  // Optimistic toggle: flip locally first, only roll back if the call fails.
  const toggleGate = async (kind: string, current: number) => {
    const next = current === 0 ? 1 : 0;
    setGates((gs) =>
      gs.map((g) => (g.phase_kind === kind ? { ...g, auto_advance: next } : g)),
    );
    try {
      await api.gatesSet(kind, next === 1);
    } catch (e) {
      setError(String(e));
      setGates((gs) =>
        gs.map((g) => (g.phase_kind === kind ? { ...g, auto_advance: current } : g)),
      );
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <Spinner />
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Heading as="h1" sx={{ fontSize: 4 }}>Settings</Heading>
      {error && <Flash variant="danger">{error}</Flash>}
      {saved && <Flash variant="success">{saved}</Flash>}

      <Section title="Azure DevOps source" subtitle="Conveyer polls this source for assigned-to-me work items.">
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
                <FormControl.Label>Entra SSO (via `az` CLI)</FormControl.Label>
              </FormControl>
              <FormControl>
                <Radio value="pat" checked={authKind === "pat"} />
                <FormControl.Label>Personal access token (env var)</FormControl.Label>
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
          {authKind === "pat" ? (
            <FormControl>
              <FormControl.Label>PAT env var</FormControl.Label>
              <TextInput value={patEnv} onChange={(e) => setPatEnv(e.target.value)} />
              <FormControl.Caption>
                Conveyer reads this env var at refresh time. Set it in your shell before launching the app.
              </FormControl.Caption>
            </FormControl>
          ) : (
            <FormControl>
              <FormControl.Label>Sign-in</FormControl.Label>
              <TextInput value="Uses your local `az` session" disabled />
              <FormControl.Caption>
                Run <code>az login</code> beforehand. If your default tenant doesn&apos;t have ADO
                access, do <code>az account set -s &lt;subscription&gt;</code> first.
              </FormControl.Caption>
            </FormControl>
          )}
        </Box>
        <Box sx={{ mt: 3 }}>
          <Button
            variant="primary"
            onClick={addSource}
            disabled={!org || !project || adding}
          >
            {adding ? "Testing & saving…" : "Add source"}
          </Button>
        </Box>

        {sources.length > 0 && (
          <Box sx={{ mt: 4, display: "flex", flexDirection: "column", gap: 2 }}>
            {sources.map((s) => (
              <SourceRow key={s.id} source={s} onDelete={() => deleteSource(s.id)} />
            ))}
          </Box>
        )}
      </Section>

      <Section title="Phase gates" subtitle="Phases set to auto-advance proceed without waiting for your approval. Submit is the terminal phase, so it has no gate.">
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {PHASE_KINDS.filter((k) => k !== "submit").map((k) => {
            const g = gates.find((x) => x.phase_kind === k) ?? { phase_kind: k, auto_advance: 0 };
            const on = g.auto_advance === 1;
            const labelId = `gate-label-${k}`;
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
      </Section>
    </Box>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Box
      sx={{
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "border.default",
        borderRadius: 2,
        p: 4,
      }}
    >
      <Heading as="h2" sx={{ fontSize: 2, mb: 1 }}>{title}</Heading>
      {subtitle && <Text sx={{ color: "fg.muted", display: "block", mb: 3 }}>{subtitle}</Text>}
      {children}
    </Box>
  );
}

function SourceRow({ source, onDelete }: { source: Source; onDelete: () => void }) {
  let cfg: AdoSourceConfig | null = null;
  try { cfg = JSON.parse(source.config_json); } catch { /* noop */ }
  const authLabel =
    source.auth_kind === "entra" ? "SSO (az)" : `PAT env: ${source.pat_env}`;
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        p: 2,
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
            {cfg.org} / {cfg.project}{cfg.team ? ` / ${cfg.team}` : ""} · {authLabel}
          </Text>
        )}
      </Box>
      <Button leadingVisual={TrashIcon} variant="danger" onClick={onDelete}>
        Delete
      </Button>
    </Box>
  );
}
