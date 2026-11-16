// Entry point: the lifecycle between this forge and the trial env.
//
// The env drives the trial. This process only has to do four things:
// bind a port, tell the env which port it picked, wait until the env
// says the trial is over, then shut down cleanly.
//
//   1. MAKEFUN_ENV_URL names the env origin (http://store:8080 inside a
//      trial container). Without it there is nothing to register with,
//      so the process exits 1 right away.
//   2. Create the forge server and listen on port 0: the kernel picks a
//      free port. Never bind 8080 — the env owns that one.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//      address the request came from plus N as the forge base URL and
//      dials it from then on. The first register wins; a 409 means
//      another entry already registered, and this process keeps waiting
//      like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The
//      env answers at once ({"done": false} while the suite runs), so
//      this is a poll, not a long-held request. A failed or slow poll is
//      retried with a short exponential backoff; the process never exits
//      before the env says done.
//   5. Close the server and exit 0. The harness then stops the env,
//      which writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './src/app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 5_000;
/** How often to ask the env whether the trial is over. */
const DONE_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ENV_URL}${path}`, { ...init, signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function register(port: number): Promise<void> {
  let wait = RETRY_INITIAL_MS;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok || res.status === 409) return;
      process.stderr.write(`[entry] register got HTTP ${res.status}, retrying\n`);
    } catch (err) {
      process.stderr.write(`[entry] register failed: ${err}, retrying\n`);
    }
    await sleep(wait);
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  }
}

async function waitDone(): Promise<void> {
  let wait = RETRY_INITIAL_MS;
  for (;;) {
    try {
      const body = await fetchJson('/done') as { done?: boolean };
      if (body?.done === true) return;
      wait = RETRY_INITIAL_MS;
      await sleep(DONE_POLL_MS);
    } catch (err) {
      process.stderr.write(`[entry] /done failed: ${err}, retrying\n`);
      await sleep(wait);
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    }
  }
}

const app = createApp();
const server = app.listen(0, async () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await register(port);
  await waitDone();
  server.close(() => process.exit(0));
});
