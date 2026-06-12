import { api } from "./api";
import { ModelInfo } from "./types";

/**
 * Module-level cache for the Copilot model list. Listing models spawns
 * the sidecar and waits for the SDK round-trip, which is slow. We do it
 * once per app session; users can clear with `clearModelsCache()` (or by
 * reloading the window).
 */
let cache: Promise<ModelInfo[]> | null = null;

export function loadModels(): Promise<ModelInfo[]> {
  if (!cache) {
    cache = api.modelsList().catch(() => [] as ModelInfo[]);
  }
  return cache;
}

export function clearModelsCache(): void {
  cache = null;
}
