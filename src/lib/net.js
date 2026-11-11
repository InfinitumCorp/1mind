// Connectivity guard for fleet runs: the operator workstation's uplink (a VPN tunnel) drops
// for minutes at a time. A step that failed because the network vanished is not a product
// failure: wait for the network to return, then retry it.

const NETWORK = /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|TLS handshake|Could not resolve host|unable to access|Failed to connect|network request|cannot reach GitHub|getaddrinfo|Connection reset|early EOF|RPC failed/i;

export const isNetworkError = (msg) => NETWORK.test(String(msg || ""));

const PROBES = ["https://api.github.com", "https://registry.npmjs.org/"];

/** True when every probe gets any HTTP response (a 403 still proves the path works). */
export async function online(probes = PROBES, timeoutMs = 8000) {
  const results = await Promise.all(
    probes.map((u) =>
      fetch(u, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) }).then(
        () => true,
        () => false,
      ),
    ),
  );
  return results.every(Boolean);
}

/** Polls until online or `maxMs` elapses. Returns whether the network came back. */
export async function waitOnline({ log = () => {}, signal, maxMs = 30 * 60_000, everyMs = 15_000, check = online } = {}) {
  const end = Date.now() + maxMs;
  let told = false;
  while (Date.now() < end) {
    if (signal?.aborted) throw new Error("cancelled");
    if (await check()) {
      if (told) log("network is back; resuming");
      return true;
    }
    if (!told) {
      log(`network down; waiting up to ${Math.round(maxMs / 60_000)} min for it to return`, "error");
      told = true;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

/** Runs `fn`, retrying up to `retries` times when it fails with a network error and the network returns. */
export async function withNetworkRetry(fn, { log, signal, retries = 2, wait = waitOnline } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isNetworkError(e.message)) throw e;
      log?.(`network error: ${e.message.split("\n")[0].slice(0, 160)}`, "error");
      if (!(await wait({ log, signal }))) throw e;
      log?.(`retrying (attempt ${attempt + 2})`);
    }
  }
}
