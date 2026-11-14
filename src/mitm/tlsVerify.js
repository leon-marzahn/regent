// Whether the MITM passthrough verifies upstream TLS certificates.
//
// Forwarded IDE traffic carries the user's provider tokens, so certificates are
// verified (server.js always sets servername). Same opt-in as open-sse proxyFetch:
// REGENT_ALLOW_INSECURE_TLS=1 skips verification, STRICT_SSL vetoes it.
// CommonJS and dependency-free: server.js runs as a standalone child process.

const truthy = (v) => v === "1" || v === "true";

function verifyUpstreamTls(env = process.env) {
  return !(truthy(env.REGENT_ALLOW_INSECURE_TLS) && !truthy(env.STRICT_SSL));
}

module.exports = { verifyUpstreamTls };
