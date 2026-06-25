// M9 High-Level HTTP wrapper —— 配置(09 章 RecorderConfig 子集 + 04 章 loopback HTTP shape)。
// 形态对齐主仓既有手写 env 校验(src/recorder/runner/config.ts resolveTempPolicy 的 {key,def,min,max}
// 表 + fail-closed ConfigError;主仓无 zod,故不用 dashboard-be 的 zod loadConfig)。差异:① 独立 env
// 命名空间 BYCLI_HIGHLEVEL_*(不复用 be 的 RECORDER_*,避免 wrapper 与 be 同机并跑抢同名 env);
// ② PORT 默认 19827(避开 daemon 19825 / be 19826);③ 无 UI_DIST / scoring profile / feature flags
// (wrapper 纯 API、不托管 UI);④ HOST 锁死 127.0.0.1(非 loopback override 直接 fail-closed)。
import { randomToken } from '@sovovs/bycli-recorder-core';
import { ConfigError } from '../../errors.js';

export interface WrapperConfig {
  readonly HOST: '127.0.0.1';
  readonly PORT: number;
  readonly ALLOWED_ORIGINS: readonly string[];
  readonly TOKEN: string;
  readonly DAEMON_PORT: number;
  readonly LOG_LEVEL: 'error' | 'warn' | 'info' | 'debug';
  /** 终态 RequestStatus TTL(过期 → getRequest 返 undefined → 404)。 */
  readonly REQUEST_TERMINAL_STATUS_TTL_MS: number;
  /** RequestStatus.pollAfterMs 提示。 */
  readonly REQUEST_POLL_AFTER_MS: number;
  /** GET /v1/requests long-poll waitMs 上限(server 侧 clamp,防客户端长挂连接)。 */
  readonly REQUEST_WAIT_MS_MAX: number;
  /** 请求体上限(超 → validation_failed)。 */
  readonly BODY_LIMIT_BYTES: number;
  /** analyze 整体超时(analyzeBrowserWithTimeout → analyze_timeout)。 */
  readonly ANALYZE_TIMEOUT_MS: number;
}

interface IntField { key: string; def: number; min: number; max: number; }
const INT_FIELDS = {
  PORT:                           { key: 'BYCLI_HIGHLEVEL_PORT',            def: 19_827,     min: 1024,   max: 65_535 },
  DAEMON_PORT:                    { key: 'BYCLI_DAEMON_PORT',               def: 19_825,     min: 1024,   max: 65_535 },
  REQUEST_TERMINAL_STATUS_TTL_MS: { key: 'BYCLI_HIGHLEVEL_REQUEST_TTL_MS',  def: 1_800_000,  min: 60_000, max: 86_400_000 },
  REQUEST_POLL_AFTER_MS:          { key: 'BYCLI_HIGHLEVEL_POLL_AFTER_MS',   def: 1_000,      min: 250,    max: 10_000 },
  REQUEST_WAIT_MS_MAX:            { key: 'BYCLI_HIGHLEVEL_WAIT_MS_MAX',     def: 25_000,     min: 1_000,  max: 60_000 },
  BODY_LIMIT_BYTES:               { key: 'BYCLI_HIGHLEVEL_BODY_LIMIT_BYTES', def: 262_144,   min: 1024,   max: 4_194_304 },
  ANALYZE_TIMEOUT_MS:             { key: 'BYCLI_HIGHLEVEL_ANALYZE_TIMEOUT_MS', def: 30_000,  min: 1_000,  max: 600_000 },
} satisfies Record<string, IntField>;

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

function intFromEnv(env: NodeJS.ProcessEnv, f: IntField): number {
  const raw = env[f.key];
  if (raw === undefined || raw === '') return f.def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < f.min || n > f.max) {
    throw new ConfigError(
      `config_invalid: ${f.key}=${raw} is out of range [${f.min}, ${f.max}]`,
      `Fix the ${f.key} environment variable and retry.`,
    );
  }
  return n;
}

/** load + validate;失败抛 ConfigError(config_invalid,fail-closed)。token 缺省时生成。 */
export function loadWrapperConfig(env: NodeJS.ProcessEnv = process.env): WrapperConfig {
  // HOST loopback-only:任何非 127.0.0.1 override 直接拒(不可绕过 loopback 绑定)。
  const host = env.BYCLI_HIGHLEVEL_HOST;
  if (host !== undefined && host !== '' && host !== '127.0.0.1') {
    throw new ConfigError(
      `config_invalid: BYCLI_HIGHLEVEL_HOST=${host} not allowed (loopback-only)`,
      'Unset BYCLI_HIGHLEVEL_HOST or set it to 127.0.0.1.',
    );
  }

  const ints = {} as Record<keyof typeof INT_FIELDS, number>;
  for (const k of Object.keys(INT_FIELDS) as (keyof typeof INT_FIELDS)[]) {
    ints[k] = intFromEnv(env, INT_FIELDS[k]);
  }

  // Origin allowlist:逗号分隔,逐个校验是合法 URL。默认空 —— 程序客户端不发 Origin 即放行;
  // 浏览器发非白名单 Origin 则被门禁拒。
  const rawOrigins = env.BYCLI_HIGHLEVEL_ALLOWED_ORIGINS;
  const origins =
    typeof rawOrigins === 'string' && rawOrigins.length
      ? rawOrigins.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  for (const o of origins) {
    try {
      new URL(o);
    } catch {
      throw new ConfigError(
        `config_invalid: invalid origin "${o}" in BYCLI_HIGHLEVEL_ALLOWED_ORIGINS`,
        'Provide comma-separated absolute URLs (e.g. http://127.0.0.1:8000).',
      );
    }
  }

  // TOKEN:显式给则 ≥16 字符,否则进程内生成(04 章 startup random,重启轮换)。
  const rawToken = env.BYCLI_HIGHLEVEL_TOKEN;
  if (rawToken !== undefined && rawToken !== '' && rawToken.length < 16) {
    throw new ConfigError(
      'config_invalid: BYCLI_HIGHLEVEL_TOKEN too short (min 16 chars)',
      'Use a token of at least 16 chars, or unset to auto-generate.',
    );
  }
  const token = rawToken && rawToken.length >= 16 ? rawToken : randomToken();

  // LOG_LEVEL:非法值 fail-closed。
  const rawLevel = env.LOG_LEVEL;
  let level: WrapperConfig['LOG_LEVEL'] = 'info';
  if (rawLevel !== undefined && rawLevel !== '') {
    if (!(LOG_LEVELS as readonly string[]).includes(rawLevel)) {
      throw new ConfigError(
        `config_invalid: LOG_LEVEL=${rawLevel} not in [${LOG_LEVELS.join(', ')}]`,
        'Set LOG_LEVEL to one of error|warn|info|debug.',
      );
    }
    level = rawLevel as WrapperConfig['LOG_LEVEL'];
  }

  return Object.freeze({
    HOST: '127.0.0.1',
    PORT: ints.PORT,
    ALLOWED_ORIGINS: Object.freeze(origins),
    TOKEN: token,
    DAEMON_PORT: ints.DAEMON_PORT,
    LOG_LEVEL: level,
    REQUEST_TERMINAL_STATUS_TTL_MS: ints.REQUEST_TERMINAL_STATUS_TTL_MS,
    REQUEST_POLL_AFTER_MS: ints.REQUEST_POLL_AFTER_MS,
    REQUEST_WAIT_MS_MAX: ints.REQUEST_WAIT_MS_MAX,
    BODY_LIMIT_BYTES: ints.BODY_LIMIT_BYTES,
    ANALYZE_TIMEOUT_MS: ints.ANALYZE_TIMEOUT_MS,
  });
}
