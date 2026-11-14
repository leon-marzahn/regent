// Fail-closed TLS verification hint: one warning line per upstream host (bounded),
// so a second broken provider still gets a TLS-specific log line.

const MAX_HOSTS = 64;

export function createTlsFailureHint({ warn = console.warn, mask = String } = {}) {
  const seen = new Set();
  return function hint(url, err) {
    const raw = String(url);
    const host = URL.canParse(raw) ? new URL(raw).host : raw;
    if (seen.has(host) || seen.size >= MAX_HOSTS) return false;
    seen.add(host);
    warn(
      `[ProxyFetch] TLS cert verification failed (${err?.cause?.code || err?.code}): ${mask(raw)}. ` +
        "Behind a TLS-inspecting proxy, add its CA with NODE_EXTRA_CA_CERTS in the server's own " +
        "environment (or, at your own risk, set REGENT_ALLOW_INSECURE_TLS=1).",
    );
    return true;
  };
}
