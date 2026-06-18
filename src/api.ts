import { invoke } from "@tauri-apps/api/core";
import type { Gate, Message, Run, RunDetail, Session, Source, TaskSummary } from "./types";
import { notifySettingChanged } from "./settingsBus";

export interface SourceInput {
  kind: string;
  name: string;
  config_json: string;
  pat_env: string;
  enabled: boolean;
  auth_kind: string;   // 'pat' | 'entra'
  az_account: string;
}

export const api = {
  // settings
  settingGet: (key: string) =>
    invoke<string | null>("settings_get", { key }),
  settingSet: async (key: string, value: string) => {
    await invoke<void>("settings_set", { key, value });
    notifySettingChanged(key);
  },
  settingsAll: () =>
    invoke<[string, string][]>("settings_all"),

  // sources
  sourcesList: () => invoke<Source[]>("sources_list"),
  sourceUpsert: (input: SourceInput) =>
    invoke<Source>("sources_upsert", { input }),
  sourceUpdate: (id: string, input: SourceInput) =>
    invoke<Source>("sources_update", { id, input }),
  sourceDelete: (id: string) => invoke<void>("sources_delete", { id }),
  sourceTest: (input: SourceInput) => invoke<void>("sources_test", { input }),

  // tasks
  tasksList: () => invoke<TaskSummary[]>("tasks_list"),
  tasksRefresh: (sourceId: string) =>
    invoke<number>("tasks_refresh", { sourceId }),
  tasksAddByUrl: (sourceId: string, url: string) =>
    invoke<TaskSummary>("tasks_add_by_url", { sourceId, url }),
  tasksSetBucket: (taskId: string, bucket: string) =>
    invoke<void>("tasks_set_bucket", { taskId, bucket }),
  taskOverridesSet: (
    taskId: string,
    overrides: {
      useWorktree: boolean | null;
      baseBranchOverride: string | null;
      branchOverride: string | null;
      enableSubmit: boolean | null;
    },
  ) =>
    invoke<void>("task_overrides_set", {
      taskId,
      useWorktree: overrides.useWorktree,
      baseBranchOverride: overrides.baseBranchOverride,
      branchOverride: overrides.branchOverride,
      enableSubmit: overrides.enableSubmit,
    }),
  taskGet: (taskId: string) =>
    invoke<import("./types").Task>("task_get", { taskId }),
  tasksSeedDemo: () => invoke<void>("tasks_seed_demo"),
  tasksCreateLocal: (title: string, description: string | null, workspacePath: string | null) =>
    invoke<string>("tasks_create_local", { title, description, workspacePath }),
  tasksDelete: (taskId: string) =>
    invoke<void>("tasks_delete", { taskId }),

  // runs
  runsStart: (taskId: string) =>
    invoke<RunDetail>("runs_start", { taskId }),
  runsForTask: (taskId: string) =>
    invoke<Run[]>("runs_for_task", { taskId }),
  runGet: (runId: string) =>
    invoke<RunDetail>("run_get", { runId }),
  phaseComplete: (phaseId: string) =>
    invoke<RunDetail>("phase_complete", { phaseId }),
  phaseApprove: (phaseId: string) =>
    invoke<RunDetail>("phase_approve", { phaseId }),
  phaseRewind: (phaseId: string) =>
    invoke<RunDetail>("phase_rewind", { phaseId }),
  phaseRestart: (phaseId: string) =>
    invoke<RunDetail>("phase_restart", { phaseId }),

  // sessions / messages / artifacts
  sessionsForPhase: (phaseId: string) =>
    invoke<Session[]>("sessions_for_phase", { phaseId }),
  messagesForSession: (sessionId: string) =>
    invoke<Message[]>("messages_for_session", { sessionId }),
  phaseArtifactGet: (phaseId: string) =>
    invoke<string | null>("phase_artifact_get", { phaseId }),
  phasePromptGet: (phaseId: string) =>
    invoke<string | null>("phase_prompt_get", { phaseId }),
  sessionCancel: (phaseId: string) =>
    invoke<boolean>("session_cancel", { phaseId }),
  chatReply: (phaseId: string, content: string) =>
    invoke<void>("chat_reply", { phaseId, content }),
  chatHeartbeat: (phaseId: string) =>
    invoke<void>("chat_heartbeat", { phaseId }),
  chatWarm: (phaseId: string) =>
    invoke<void>("chat_warm", { phaseId }),
  phaseSubmitInput: (phaseId: string, content: string) =>
    invoke<void>("phase_submit_input", { phaseId, content }),

  // review comments
  commentsForPhase: (phaseId: string) =>
    invoke<import("./types").Comment[]>("comments_for_phase", { phaseId }),
  commentCreate: (input: {
    phase_id: string;
    file_path: string;
    line_start: number | null;
    line_end: number | null;
    side: string | null;
    snippet: string | null;
    body: string;
  }) => invoke<import("./types").Comment>("comment_create", { input }),
  commentAccept: (commentId: string) =>
    invoke<import("./types").Comment>("comment_accept", { commentId }),
  commentReopen: (commentId: string, followUp: string) =>
    invoke<import("./types").Comment>("comment_reopen", { input: { comment_id: commentId, follow_up: followUp } }),
  commentDelete: (commentId: string) =>
    invoke<void>("comment_delete", { commentId }),
  modelsList: () => invoke<import("./types").ModelInfo[]>("models_list"),

  // diff
  phaseDiffSummary: (phaseId: string) =>
    invoke<import("./types").DiffSummary | null>("phase_diff_summary", { phaseId }),
  phaseDiffText: (phaseId: string, commit?: string | null) =>
    invoke<string>("phase_diff_text", { phaseId, commit: commit ?? null }),

  // pull requests (submit phase)
  pullRequestForPhase: (phaseId: string) =>
    invoke<import("./types").PullRequest | null>("pull_request_for_phase", { phaseId }),
  prCreate: (phaseId: string) => invoke<void>("pr_create", { phaseId }),

  // workspaces
  workspacesList: () => invoke<import("./types").Workspace[]>("workspaces_list"),
  workspaceUpsert: (id: number | null, name: string, path: string) =>
    invoke<import("./types").Workspace>("workspace_upsert", { id, input: { name, path } }),
  workspaceDelete: (id: number) => invoke<void>("workspace_delete", { id }),
  taskSetWorkspace: (taskId: string, workspacePath: string | null) =>
    invoke<void>("task_set_workspace", { taskId, workspacePath }),

  // gates
  gatesList: () => invoke<Gate[]>("gates_list"),
  gatesSet: (phaseKind: string, autoAdvance: boolean) =>
    invoke<void>("gates_set", { phaseKind, autoAdvance }),
};
