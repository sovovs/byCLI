import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolvers for the byCLI user-data root and its well-known subdirectories.
 *
 * The root is `BYCLI_CONFIG_DIR` when set, else `~/.bycli`. These are FUNCTIONS,
 * not module-level constants, on purpose: `BYCLI_CONFIG_DIR` is set dynamically
 * (tests, the verify child sandbox in runner-port.ts) — a const captured at import
 * time would freeze the wrong root and leak across tests. Always resolve on call.
 *
 * Existing duplicate idioms this consolidates: observation/artifact.ts, browser/profile.ts.
 */
export function getConfigDir(): string {
  return process.env.BYCLI_CONFIG_DIR || path.join(os.homedir(), '.bycli');
}

/** User adapter root: `$CONFIG_DIR/clis`. Adapters live at `<clis>/<site>/<command>.js`. */
export function getUserClisDir(): string {
  return path.join(getConfigDir(), 'clis');
}

/** Per-site memory/recorder root: `$CONFIG_DIR/sites`. */
export function getSitesDir(): string {
  return path.join(getConfigDir(), 'sites');
}

/** A single site's directory: `$CONFIG_DIR/sites/<site>`. */
export function getSiteDir(site: string): string {
  return path.join(getSitesDir(), site);
}

/** A site's recorder artifact dir: `$CONFIG_DIR/sites/<site>/recorder`. */
export function getSiteRecorderDir(site: string): string {
  return path.join(getSiteDir(site), 'recorder');
}
