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
export type GithubAuthKind = "gh" | "pat";

export interface AdoSourceConfig {
  org: string;
  project: string;
  team?: string;
}

export interface GithubSourceConfig {
  owner: string;
  repo?: string;
  host?: string;
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
  workspace_path: string | null;
  /** Per-task override: null = inherit settings.use_worktree, else 0/1. */
  use_worktree: number | null;
  /** Per-task override: null = auto-detect from remote default branch. */
  base_branch_override: string | null;
  /** Per-task override: null = create new <alias>/<slug>; else this existing branch. */
  branch_override: string | null;
  /** Per-task override: null = inherit settings.phase_submit_enabled, else 0/1. */
  enable_submit: number | null;
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
  /** "approve" | "request_changes" | null. Only populated on review phases. */
  review_verdict: string | null;
  /** Free-text reason supplied with a request_changes verdict. */
  review_reason: string | null;
  /** JSON string {request_id, prompt, choices, kind} when status is "needs_input". */
  pending_input: string | null;
}

export interface PendingInput {
  request_id: string;
  prompt: string;
  choices?: string[] | null;
  kind?: string | null;
}

export interface Comment {
  id: string;
  phase_id: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  side: string | null;
  snippet: string | null;
  body: string;
  status: string; // queued | working | addressed | accepted
  agent_reply: string | null;
  commit_marker: string;
  thread_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommentMessage {
  role: "user" | "agent";
  content: string;
}

export interface PrCheck {
  name: string;
  status: string;
}

export interface PullRequest {
  phase_id: string;
  title: string;
  source_branch: string | null;
  target_branch: string | null;
  description: string | null;
  status: string; // draft | creating | created | failed
  number: number | null;
  url: string | null;
  checks_json: string | null;
  reviewers_json: string | null;
  work_items_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
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
  sdk_session_id: string | null;
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

export interface Workspace {
  id: number;
  name: string;
  path: string;
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
