export interface Source {
  id: string;
  kind: string;
  name: string;
  config_json: string;
  pat_env: string;
  enabled: number;
  created_at: string;
}

export interface AdoSourceConfig {
  org: string;
  project: string;
  team?: string;
}

export interface Task {
  id: string;
  source_id: string;
  source_ref: string;
  title: string;
  state: string;
  url: string;
  source_meta_json: string;
  discovered_at: string;
  updated_at: string;
}

export interface TaskSummary extends Task {
  run_status: string | null;
}

export interface Gate {
  phase_kind: string;
  auto_advance: number;
}

export type PhaseKind =
  | "exploration"
  | "planning"
  | "implementation"
  | "review"
  | "submit";

export const PHASE_KINDS: PhaseKind[] = [
  "exploration",
  "planning",
  "implementation",
  "review",
  "submit",
];
