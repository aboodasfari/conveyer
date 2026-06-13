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
  // Strip Rust-side prefixes so we don't end up with "Error: Not found: …".
  msg = msg.replace(/^error:\s*/i, "");
  msg = msg.replace(/^not found:\s*/i, "");
  return `Error: ${msg}`;
}
