// ConfigPort(02/09 章):env → 校验过的 RecorderConfig 快照。业务代码不直接读 process.env。
// 非法配置 fail-fast,以 config_invalid 语义抛出。本 shell 只取 09 章 RecorderConfig 的相关子集
// + localhost HTTP 形态所需的 port/origin/token 项;其余键(temp/watermark/scoring)留待后续里程碑。
import { z } from 'zod';
import {
  resolveScoringProfile, resolveFeatureFlags,
  type ScoringProfile, type FeatureFlags,
} from '@sovovs/bycli-recorder-core';
import { randomToken } from './security/bootstrap.js';

const intFromEnv = (def: number, min: number, max: number) =>
  z
    .preprocess((v) => (v === undefined || v === '' ? def : Number(v)), z.number().int().min(min).max(max))
    .default(def);

const ConfigSchema = z.object({
  // 04 章 localhost HTTP shape
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: intFromEnv(19826, 1024, 65535),
  // 只认自身 UI origin(Origin allowlist);逗号分隔
  ALLOWED_ORIGINS: z
    .preprocess(
      (v) => (typeof v === 'string' && v.length ? v.split(',').map((s) => s.trim()) : ['http://127.0.0.1:8000', 'http://localhost:8000']),
      z.array(z.string().url()),
    )
    .default(['http://127.0.0.1:8000', 'http://localhost:8000']),
  // 启动随机 token;未显式给则进程内生成(对齐 04 章 generation:parent 启动生成)
  TOKEN: z.string().min(16).optional(),
  // daemon bridge
  DAEMON_PORT: intFromEnv(19825, 1024, 65535),
  // 可选:dashboard build 产物目录。设了才同源托管 UI + 注入 bootstrap;不设为 API-only(默认)。
  UI_DIST: z.string().min(1).optional(),
  // 09 章 RecorderConfig 子集(shell 已用到的)
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  RECORDER_MAX_ACTIVE_SESSIONS: intFromEnv(2, 1, 10),
  REQUEST_TERMINAL_STATUS_TTL_MS: intFromEnv(1_800_000, 60_000, 86_400_000),
  REQUEST_POLL_AFTER_MS: intFromEnv(1000, 250, 10_000),
});

export type RecorderConfig = Readonly<z.infer<typeof ConfigSchema>> & {
  TOKEN: string;
  /** Externalized ScoringProfile (M8a · 09); RANK_SCORE_* overrides apply only when
   * featureFlags.FEATURE_PREVIEW_SCORING_PROFILE is on (else the default profile is used). */
  scoringProfile: ScoringProfile;
  featureFlags: FeatureFlags;
};

export class ConfigInvalidError extends Error {
  readonly code = 'config_invalid' as const;
}

/** load + validate;失败抛 ConfigInvalidError(config_invalid)。token 缺省时生成。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RecorderConfig {
  const parsed = ConfigSchema.safeParse({
    HOST: env.RECORDER_HOST,
    PORT: env.RECORDER_PORT,
    ALLOWED_ORIGINS: env.RECORDER_ALLOWED_ORIGINS,
    TOKEN: env.RECORDER_TOKEN,
    DAEMON_PORT: env.BYCLI_DAEMON_PORT,
    UI_DIST: env.RECORDER_UI_DIST,
    LOG_LEVEL: env.LOG_LEVEL,
    RECORDER_MAX_ACTIVE_SESSIONS: env.RECORDER_MAX_ACTIVE_SESSIONS,
    REQUEST_TERMINAL_STATUS_TTL_MS: env.REQUEST_TERMINAL_STATUS_TTL_MS,
    REQUEST_POLL_AFTER_MS: env.REQUEST_POLL_AFTER_MS,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigInvalidError(`config_invalid: ${detail}`);
  }
  const token = parsed.data.TOKEN ?? randomToken();
  // ScoringProfile + FeatureFlags(M8a · 09):env 键名 == 字段名,直接传 env;非法即 fail-fast。
  // 始终校验(即便 preview 关也校 RANK_SCORE_*,守 09「所有 config 校验」),应用与否由 handleRank 按 flag 决定。
  const sp = resolveScoringProfile(env as Partial<Record<keyof ScoringProfile, string | undefined>>);
  if (!sp.ok) throw new ConfigInvalidError(`config_invalid: ${sp.reason}`);
  const ff = resolveFeatureFlags(env as Partial<Record<keyof FeatureFlags, string | undefined>>);
  if (!ff.ok) throw new ConfigInvalidError(`config_invalid: ${ff.reason}`);
  // be 同源托管 UI 时,浏览器发来的 Origin = be 自己的源,必须在白名单内(否则门禁拒掉同源请求)。
  // be 自己的源永远可信,自动并入。
  const ownOrigins = [`http://${parsed.data.HOST}:${parsed.data.PORT}`, `http://localhost:${parsed.data.PORT}`];
  const ALLOWED_ORIGINS = [...new Set([...parsed.data.ALLOWED_ORIGINS, ...ownOrigins])];
  return Object.freeze({ ...parsed.data, ALLOWED_ORIGINS, TOKEN: token, scoringProfile: sp.profile, featureFlags: ff.flags });
}
