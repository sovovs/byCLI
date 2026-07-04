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

const boolFromEnv = (def: boolean) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : v === '1' || v === 'true'), z.boolean()).default(def);

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
  // 可选:embedded_iframe 录制模式的 CSP frame-src hardened override(逗号分隔 https origin)。
  // 仅在 FEATURE_EMBEDDED_IFRAME_RECORDING 开时生效:不设 → frame-src https:(填 URL 即录);
  // 设了 → frame-src 只放这些 origin(CI/企业收窄)。只认 https origin,非法即 fail-fast。
  IFRAME_FRAME_SRC: z
    .preprocess(
      (v) => (typeof v === 'string' && v.length ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined),
      z.array(z.string().url().startsWith('https://')).optional(),
    )
    .optional(),
  // 09 章 RecorderConfig 子集(shell 已用到的)
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  RECORDER_MAX_ACTIVE_SESSIONS: intFromEnv(2, 1, 10),
  REQUEST_TERMINAL_STATUS_TTL_MS: intFromEnv(1_800_000, 60_000, 86_400_000),
  REQUEST_POLL_AFTER_MS: intFromEnv(1000, 250, 10_000),
  // 喂 LLM 评分/生成的候选软上限(决定默认勾选 top-N + 无手选时自动截断数)。越大召回越多但 prompt 越大越慢。
  // 默认 8(比旧 5 略提召回),上限放宽到 100(本地工具,不人为锁 20;防爆靠 prompt budget+单候选隔离+手选)。
  // **手选 candidateIds 不受此 cap 截断**(手选优先)——见 selectCandidatesForLlm。
  // 2026-07-02 由 8 提到 10:配合 MAX_SCORE_PROMPT_CHARS 60000 + paramObservations 精简,让 ~10 个候选
  // 都能进 LLM(真机诊断 cap=8 时 /search 等被预算 pop);富数据候选精简后单个 ~3-4KB,10 个仍在 60KB 内。
  RECORDER_LLM_CANDIDATE_CAP: intFromEnv(10, 1, 100),
  // LLM 合成(MVP):接 Anthropic(兼容)API 用 A/B 痕迹+截图生成 adapter func/columns。默认关。
  // 须 FEATURE_LLM_SYNTHESIS=1 且有 RECORDER_LLM_API_KEY 才启用;否则 init 退回空模板(行为不变)。
  // **刻意用 RECORDER_LLM_* 项目命名空间,不用 ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL** —— 避免与
  // Claude Code 等工具预置的同名 env 冲突(node --env-file 不覆盖已存在 env)。SDK client 显式传值 +
  // authToken:null,完全不读环境里的 ANTHROPIC_*。RECORDER_LLM_BASE_URL 指向第三方兼容网关(可空=官方)。
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_SYNTHESIS_ENABLED: boolFromEnv(false),
  LLM_MODEL: z.string().min(1).default('claude-opus-4-8'),
  // 单次 LLM 调用超时(ms)。SDK 默认 600s(10min)+2 retries,第三方兼容网关偶发高延迟时会把 rank
  // 阶段挂满 10min 再抛(实测 618s)→ 静默退回规则分、用户看到误导性低分。显式收窄到 3min 快速失败。
  // makeLlmClient 一并设 maxRetries:1(默认 2 会成倍放大挂起时长)。
  LLM_TIMEOUT_MS: intFromEnv(180_000, 5_000, 600_000),
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
    IFRAME_FRAME_SRC: env.RECORDER_IFRAME_FRAME_SRC,
    LOG_LEVEL: env.LOG_LEVEL,
    RECORDER_MAX_ACTIVE_SESSIONS: env.RECORDER_MAX_ACTIVE_SESSIONS,
    REQUEST_TERMINAL_STATUS_TTL_MS: env.REQUEST_TERMINAL_STATUS_TTL_MS,
    REQUEST_POLL_AFTER_MS: env.REQUEST_POLL_AFTER_MS,
    RECORDER_LLM_CANDIDATE_CAP: env.RECORDER_LLM_CANDIDATE_CAP,
    LLM_API_KEY: env.RECORDER_LLM_API_KEY,
    LLM_BASE_URL: env.RECORDER_LLM_BASE_URL,
    LLM_SYNTHESIS_ENABLED: env.FEATURE_LLM_SYNTHESIS,
    LLM_MODEL: env.RECORDER_LLM_MODEL,
    LLM_TIMEOUT_MS: env.RECORDER_LLM_TIMEOUT_MS,
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
