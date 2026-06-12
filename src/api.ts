import { invoke } from "@tauri-apps/api/core";
import type { Gate, Message, Run, RunDetail, Session, Source, TaskSummary } from "./types";

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
  settingSet: (key: string, value: string) =>
    invoke<void>("settings_set", { key, value }),
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

  // sessions / messages / artifacts
  sessionsForPhase: (phaseId: string) =>
    invoke<Session[]>("sessions_for_phase", { phaseId }),
  messagesForSession: (sessionId: string) =>
    invoke<Message[]>("messages_for_session", { sessionId }),
  phaseArtifactGet: (phaseId: string) =>
    invoke<string | null>("phase_artifact_get", { phaseId }),
  sessionCancel: (phaseId: string) =>
    invoke<boolean>("session_cancel", { phaseId }),

  // gates
  gatesList: () => invoke<Gate[]>("gates_list"),
  gatesSet: (phaseKind: string, autoAdvance: boolean) =>
    invoke<void>("gates_set", { phaseKind, autoAdvance }),
};
