#!/usr/bin/env node
/**
 * Standalone smoke test for sendAndWaitWithActivity and resolveInactivityMs.
 *
 * No test framework: pure-Node script that exits 0 on success, throws on
 * failure. Run with: `node sidecar/test/watchdog.smoke.mjs`
 */

import {
  sendAndWaitWithActivity,
  resolveInactivityMs,
} from "../conveyer-agent.mjs";

function makeSession() {
  const listeners = new Set();
  return {
    listeners,
    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    // never resolves — the watchdog (or activity) decides the outcome.
    async sendAndWait(_prompt, _timeoutMs) {
      await new Promise(() => {});
    },
    fire(event) {
      for (const h of listeners) h(event);
    },
  };
}

// --- resolveInactivityMs ---------------------------------------------------

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

assertEq(resolveInactivityMs({}), 2 * 60 * 60 * 1000, "default");
assertEq(resolveInactivityMs({ CONVEYER_PHASE_INACTIVITY_MS: "" }), 2 * 60 * 60 * 1000, "empty");
assertEq(resolveInactivityMs({ CONVEYER_PHASE_INACTIVITY_MS: "abc" }), 2 * 60 * 60 * 1000, "non-numeric");
assertEq(resolveInactivityMs({ CONVEYER_PHASE_INACTIVITY_MS: "0" }), 2 * 60 * 60 * 1000, "zero");
assertEq(resolveInactivityMs({ CONVEYER_PHASE_INACTIVITY_MS: "-5" }), 2 * 60 * 60 * 1000, "negative");
assertEq(resolveInactivityMs({ CONVEYER_PHASE_INACTIVITY_MS: "1500" }), 1500, "valid int");

// --- (a) fires after inactivity ------------------------------------------

async function testFiresOnSilence() {
  const session = makeSession();
  const start = Date.now();
  let err;
  try {
    await sendAndWaitWithActivity({
      session,
      prompt: { prompt: "hi" },
      inactivityMs: 100,
    });
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - start;
  if (!err) throw new Error("expected inactivity rejection, got none");
  if (!/No activity from agent for 100ms/.test(err.message)) {
    throw new Error(`unexpected error message: ${err.message}`);
  }
  if (elapsed < 80) throw new Error(`fired too fast (${elapsed}ms)`);
  if (elapsed > 600) throw new Error(`fired too slow (${elapsed}ms)`);
  // Confirm the listener was cleaned up.
  if (session.listeners.size !== 0) {
    throw new Error(`listener not cleaned up (size=${session.listeners.size})`);
  }
}

// --- (b) does NOT fire while events keep arriving -------------------------

async function testStaysAliveWhileBusy() {
  const session = makeSession();
  let rejected = false;
  let rejectionErr;
  const pending = sendAndWaitWithActivity({
    session,
    prompt: { prompt: "hi" },
    inactivityMs: 200,
  }).catch((e) => { rejected = true; rejectionErr = e; });

  // Fire an event every 50ms for 400ms — total wall-clock 400ms is well
  // beyond the 200ms inactivity window, but no single gap exceeds it.
  const start = Date.now();
  while (Date.now() - start < 400) {
    session.fire({ type: "assistant.message_delta" });
    await new Promise((r) => setTimeout(r, 50));
  }

  // Quick sanity check: should still be pending (not rejected) right now.
  if (rejected) {
    throw new Error(`watchdog fired despite activity: ${rejectionErr?.message}`);
  }

  // Now stop firing and wait long enough for the watchdog to trip.
  await new Promise((r) => setTimeout(r, 350));
  if (!rejected) {
    throw new Error("watchdog never fired after activity stopped");
  }
  if (!/No activity from agent for 200ms/.test(rejectionErr.message)) {
    throw new Error(`unexpected error message: ${rejectionErr.message}`);
  }

  // Swallow the awaited promise (already handled via .catch above).
  await pending;
  if (session.listeners.size !== 0) {
    throw new Error(`listener not cleaned up (size=${session.listeners.size})`);
  }
}

await testFiresOnSilence();
await testStaysAliveWhileBusy();
console.log("OK");
