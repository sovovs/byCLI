import { DEFAULT_DAEMON_PORT } from '../constants.js';

export type DaemonPortResolution =
  | { ok: true; port: number }
  | { ok: false; port: typeof DEFAULT_DAEMON_PORT };

export function resolveDaemonPort(raw = process.env.BYCLI_DAEMON_PORT): DaemonPortResolution {
  if (raw === undefined) return { ok: true, port: DEFAULT_DAEMON_PORT };
  if (!/^\d+$/.test(raw)) return { ok: false, port: DEFAULT_DAEMON_PORT };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, port: DEFAULT_DAEMON_PORT };
  }
  return { ok: true, port };
}
