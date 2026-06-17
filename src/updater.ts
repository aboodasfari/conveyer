import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "up-to-date";

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  currentVersion?: string;
  notes?: string;
  progress?: { downloaded: number; total?: number };
  error?: string;
}

type Listener = () => void;

let state: UpdateState = { status: "idle" };
let pendingUpdate: Update | null = null;
const listeners = new Set<Listener>();

function setState(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function getState(): UpdateState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateStatus(): UpdateState {
  return useSyncExternalStore(subscribe, getState, getState);
}

async function ensureCurrentVersion() {
  if (state.currentVersion) return;
  try {
    const v = await getVersion();
    setState({ currentVersion: v });
  } catch {
    // ignore — non-fatal
  }
}

export async function checkNow(): Promise<void> {
  if (state.status === "checking" || state.status === "downloading") return;
  await ensureCurrentVersion();
  setState({ status: "checking", error: undefined });
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      setState({
        status: "available",
        version: update.version,
        notes: update.body ?? undefined,
      });
    } else {
      pendingUpdate = null;
      setState({ status: "up-to-date" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[updater] check failed", message);
    setState({ status: "error", error: message });
  }
}

export async function installAndRelaunch(): Promise<void> {
  const update = pendingUpdate;
  if (!update) {
    console.info("[updater] install requested but no pending update; re-checking");
    await checkNow();
    if (!pendingUpdate) {
      console.warn("[updater] still no pending update after re-check; aborting install");
      return;
    }
    return installAndRelaunch();
  }
  console.info(`[updater] starting install of v${update.version}`);
  setState({ status: "downloading", progress: { downloaded: 0 } });
  try {
    let total: number | undefined;
    let downloaded = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength;
          console.info(`[updater] download started (${total ?? "?"} bytes)`);
          setState({ progress: { downloaded: 0, total } });
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          setState({ progress: { downloaded, total } });
          break;
        case "Finished":
          console.info("[updater] download finished; bundle installed, relaunching");
          setState({ status: "ready" });
          break;
      }
    });
    console.info("[updater] calling relaunch()");
    await relaunch();
    console.info("[updater] relaunch() returned (app should be restarting)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[updater] install failed", message, err);
    setState({ status: "error", error: message });
  }
}

let started = false;
const DAY_MS = 24 * 60 * 60 * 1000;
const FOCUS_THROTTLE_MS = 60 * 60 * 1000;
let lastFocusCheck = 0;

export function start(): void {
  if (started) return;
  started = true;
  console.info("[updater] starting; checking for updates");
  void checkNow();
  setInterval(() => {
    void checkNow();
  }, DAY_MS);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => {
      const now = Date.now();
      if (now - lastFocusCheck < FOCUS_THROTTLE_MS) return;
      lastFocusCheck = now;
      void checkNow();
    });
  }
}
