// Fork-owned stand-in for upstream's lazyRuntime.js.
//
// Upstream downloads optional packages (wreq-js, playwright-core) into
// <DATA_DIR>/runtime with npm on first use. We don't install code at runtime:
// optional deps come from the lockfile (`optionalDependencies` in package.json),
// so this only imports what is already installed, from an allow-list. Callers
// keep upstream's `loadRuntimeDep(name)` contract: it rejects when the package
// is unavailable, and they fall back as they would upstream.

const ALLOWED = new Set(["wreq-js"]);

// Non-literal, bundler-ignored specifier: webpack/turbopack must not try to
// resolve an optional package at build time (it's in serverExternalPackages).
const importOptional = (name) => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ name);

const cache = new Map();

export function loadRuntimeDep(name) {
  if (!ALLOWED.has(name)) return Promise.reject(new Error(`runtime dependency not allowed: ${name}`));
  if (!cache.has(name)) {
    const promise = importOptional(name)
      .then((mod) => mod?.default && !mod.createSession ? mod.default : mod)
      .catch((err) => {
        cache.delete(name);
        throw err;
      });
    cache.set(name, promise);
  }
  return cache.get(name);
}
