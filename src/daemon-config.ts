import { ConfigError } from './errors.js';

export type DaemonHost = '127.0.0.1' | '0.0.0.0';

export function resolveDaemonHost(env: NodeJS.ProcessEnv = process.env): DaemonHost {
  const raw = env.BYCLI_DAEMON_HOST;
  if (raw === undefined || raw === '') {
    return '127.0.0.1';
  }
  if (raw === '127.0.0.1' || raw === '0.0.0.0') {
    return raw;
  }
  throw new ConfigError(
    `config_invalid: BYCLI_DAEMON_HOST=${raw} is not allowed`,
    'Use 127.0.0.1 for local use or 0.0.0.0 for an isolated sandbox.',
  );
}
