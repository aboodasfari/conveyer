export interface Source {
  id: string;
  kind: string;
  name: string;
  config_json: string;
  pat_env: string;
  enabled: number;
  created_at: string;
  auth_kind: string;   // 'pat' | 'entra'
  az_account: string;
}

export type AuthKind = "pat" | "entra";

export interface AdoSourceConfig {
  org: string;
  project: string;
  team?: string;
}

export type Bucket = "active" | "backlog" | "archive";
export const BUCKETS: Bucket[] = ["active", "backlog", "archive"];

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
  parent_ref: string | null;
  is_self_assigned: number;
  description: string | null;
  bucket: Bucket;
}

export interface TaskSummary extends Task {
  run_status: string | null;
  current_phase: string | null;
}

export interface Run {
  id: string;
  task_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
}

export interface Phase {
  id: string;
  run_id: string;
  kind: PhaseKind;
  ord: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  artifact_path: string | null;
}

export interface RunDetail {
  run: Run;
  phases: Phase[];
}

export interface Session {
  id: string;
  phase_id: string;
  role: string;
  status: string;
  pid: number | null;
  log_path: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  supported_reasoning_efforts?: string[] | null;
  default_reasoning_effort?: string | null;
}

export interface Message {
  id: number;
  session_id: string;
  ts: string;
  role: string;
  content: string;
}

export interface Gate {
  phase_kind: string;
  auto_advance: number;
}

export interface CommitInfo {
  sha: string;
  short_sha: string;
  subject: string;
  author: string;
  ts: string;
}

export interface DiffSummary {
  branch: string;
  base_sha: string;
  head_sha: string;
  worktree_path: string;
  commits: CommitInfo[];
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
