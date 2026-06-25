// ConfigPort 热加载(M8d · 09 Hot Reload Policy)。
// reload() 重读+校验完整 config,合法则**原子 swap 版本化快照**:仅热字段更新,**安全/restart 字段
// 永远钉死从启动快照**(09 restart-required 表:token/origin/端口/listener/endpoint-surface flags/
// registry 容量/TTL),hot reload 绝不放宽 redaction 或安全边界。失败保旧、返回 config_invalid。
// LOG_LEVEL 是唯一即时全局例外(经回调直接调 logger.setLevel)。
//
// 注:be config 源是 env;运行中 process.env 不变,故经 SIGHUP 重读 process.env 是 no-op ——
// reload(env) 接受注入便于测试 + 未来文件源。机制(版本快照 / pin-security / apply-hot)是交付物。
import { loadConfig, type RecorderConfig, ConfigInvalidError } from './config.js';

export type ReloadResult = { ok: true; version: number } | { ok: false; reason: string };

export interface ConfigPort {
  /** 当前活动快照(新请求读它取热字段;pinned 字段恒等于启动值)。 */
  current(): RecorderConfig;
  version(): number;
  reload(env?: NodeJS.ProcessEnv): ReloadResult;
}

/**
 * @param startup  启动快照(loadConfig 产出,frozen)。pinned 字段永取自它。
 * @param onLevelChange  LOG_LEVEL 即时全局例外(09):reload 成功后立即应用,不等快照版本。
 */
export function createConfigPort(
  startup: RecorderConfig,
  onLevelChange: (level: RecorderConfig['LOG_LEVEL']) => void,
): ConfigPort {
  let active = startup;
  let version = 1;
  return {
    current: () => active,
    version: () => version,
    reload(env = process.env) {
      let fresh: RecorderConfig;
      try {
        fresh = loadConfig(env);
      } catch (e) {
        // 失败保旧(09):current 不变、版本不变。
        return { ok: false, reason: e instanceof ConfigInvalidError ? e.message : String(e) };
      }
      // 合法 → 新快照 = 启动 pinned 字段 + fresh 的热字段。restart/安全字段绝不从 fresh 取。
      active = Object.freeze({
        ...startup, // pinned: HOST/PORT/ALLOWED_ORIGINS/TOKEN/DAEMON_PORT/UI_DIST/RECORDER_MAX_ACTIVE_SESSIONS/REQUEST_TERMINAL_STATUS_TTL_MS
        LOG_LEVEL: fresh.LOG_LEVEL,
        REQUEST_POLL_AFTER_MS: fresh.REQUEST_POLL_AFTER_MS,
        scoringProfile: fresh.scoringProfile,
        featureFlags: Object.freeze({
          ...startup.featureFlags, // restart-only flags pinned (DIRECT_CDP_CAPTURE/LOCALHOST_HTTP_UI/ADMIN_LOG_LEVEL_TOGGLE)
          FEATURE_PREVIEW_SCORING_PROFILE: fresh.featureFlags.FEATURE_PREVIEW_SCORING_PROFILE,
          RELEASE_CHANNEL: fresh.featureFlags.RELEASE_CHANNEL,
          LOCAL_EXPERIMENT_PROFILE: fresh.featureFlags.LOCAL_EXPERIMENT_PROFILE,
        }),
      });
      version += 1;
      onLevelChange(active.LOG_LEVEL); // LOG_LEVEL 即时全局(含 in-flight),只调日志详度、不动 redaction
      return { ok: true, version };
    },
  };
}
