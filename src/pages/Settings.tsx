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
  const [azAccount, setAzAccount] = useState("");
  const [name, setName] = useState("");

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
    try {
      const cfg: AdoSourceConfig = { org, project, team: team || undefined };
      await api.sourceUpsert({
        kind: "ado",
        name: name || `${org}/${project}`,
        config_json: JSON.stringify(cfg),
        pat_env: patEnv,
        enabled: true,
        auth_kind: authKind,
        az_account: azAccount,
      });
      setOrg(""); setProject(""); setTeam(""); setName(""); setAzAccount("");
      setSaved("Source added");
      await load();
    } catch (e) {
      setError(String(e));
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

  const toggleGate = async (kind: string, current: number) => {
    try {
      await api.gatesSet(kind, current === 0);
      await load();
    } catch (e) {
      setError(String(e));
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
              <FormControl.Label>az subscription (optional)</FormControl.Label>
              <TextInput
                value={azAccount}
                onChange={(e) => setAzAccount(e.target.value)}
                placeholder="leave blank for default"
              />
              <FormControl.Caption>
                Uses your local Azure CLI. Make sure `az login` has been done.
              </FormControl.Caption>
            </FormControl>
          )}
        </Box>
        <Box sx={{ mt: 3 }}>
          <Button variant="primary" onClick={addSource} disabled={!org || !project}>
            Add source
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

      <Section title="Phase gates" subtitle="Phases set to auto-advance proceed without waiting for your approval.">
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {PHASE_KINDS.map((k) => {
            const g = gates.find((x) => x.phase_kind === k) ?? { phase_kind: k, auto_advance: 0 };
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
                <Text sx={{ textTransform: "capitalize" }}>{k}</Text>
                <ToggleSwitch
                  checked={g.auto_advance === 1}
                  onChange={() => toggleGate(k, g.auto_advance)}
                  aria-label={`Auto advance ${k}`}
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
    source.auth_kind === "entra"
      ? `SSO${source.az_account ? ` (${source.az_account})` : ""}`
      : `PAT env: ${source.pat_env}`;
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
