/**
 * Normalises an unknown thrown value into a user-facing string.
 * Tauri rejects with the Rust error's Display string; we strip the surrounding
 * `Error: …` and just keep the message, then re-prefix consistently.
 */
export function formatError(e: unknown): string {
  let msg: string;
  if (e instanceof Error) msg = e.message;
  else if (typeof e === "string") msg = e;
  else msg = String(e);

  msg = msg.trim();
  if (/^error:\s*/i.test(msg)) {
    msg = msg.replace(/^error:\s*/i, "");
  }
  return `Error: ${msg}`;
}
