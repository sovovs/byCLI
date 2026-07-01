// VNC 录制模式的容器编排(A 形态:be 同机自动 podman run 起容器)。
// 一会话一容器:容器内 Chromium+扩展+daemon(127.0.0.1:19825)+ x11vnc + websockify(6080)+ 网关(7000)。
// 出墙只映射 6080(noVNC 画面)+ 7000(网关,daemon /command 受控反代);daemon 19825 不出墙。
// 依赖宿主 podman + 镜像 bycli-verify:latest(scripts/recorder.sh build vnc 构建)。无 podman/镜像 → 优雅失败。
import { spawn } from 'node:child_process';

const IMAGE = process.env.BYCLI_VNC_IMAGE || 'bycli-verify:latest';
const PODMAN = process.env.BYCLI_PODMAN_BIN || 'podman';
const READY_TIMEOUT_MS = Number(process.env.BYCLI_VNC_READY_TIMEOUT_MS || 40000);

export interface VncContainer {
  containerName: string;
  /** 宿主映射端口:noVNC 画面(前端 iframe 直连)。 */
  vncPort: number;
  /** 宿主映射端口:网关(be 的 daemonBridge 指向它,反代到容器内 daemon)。 */
  gatewayPort: number;
}

export interface VncOrchestrator {
  start(sessionId: string): Promise<VncContainer>;
  stop(sessionId: string): Promise<void>;
  get(sessionId: string): VncContainer | undefined;
  stopAll(): Promise<void>;
}

interface OrchestratorDeps {
  logger?: { info: (op: string, f?: Record<string, unknown>) => void; warn: (op: string, f?: Record<string, unknown>) => void };
}

/** 运行一条 podman 命令,collect stdout;非 0 退出码 reject。 */
function podman(args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(PODMAN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`podman ${args[0]} timeout`)); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`podman ${args[0]} exit ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

async function hostPort(containerName: string, containerPort: number): Promise<number> {
  const out = await podman(['inspect', containerName, '--format', `{{(index .NetworkSettings.Ports "${containerPort}/tcp" 0).HostPort}}`]);
  const n = parseInt(out, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`无法解析容器 ${containerName} 的 ${containerPort} 映射端口: ${JSON.stringify(out)}`);
  return n;
}

async function waitReady(url: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(url, { signal: ctrl.signal }).catch(() => null);
      clearTimeout(t);
      if (r && r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`readiness 超时: ${url}`);
}

export function createVncOrchestrator(deps: OrchestratorDeps = {}): VncOrchestrator {
  const log = deps.logger;
  const containers = new Map<string, VncContainer>();
  // 测试阶段:固定容器名(单容器复用,不按 sessionId 区分)。这样不同 session 复用同一容器,
  // 避免每次 bind 都重建 + 保留登录态/录制环境。环境变量 BYCLI_VNC_CONTAINER 可覆盖。
  // (多会话隔离=生产形态,届时改回按 sessionId 命名 + 一会话一容器。)
  const CONTAINER_NAME = process.env.BYCLI_VNC_CONTAINER || 'bycli-vnc';
  const nameOf = (_sessionId: string) => CONTAINER_NAME;

  return {
    get: (sessionId) => containers.get(sessionId),

    async start(sessionId) {
      const existing = containers.get(sessionId);
      if (existing) return existing;
      const containerName = nameOf(sessionId);
      // 测试阶段:复用现有容器而非每次重建。按名查容器状态:
      //   running → 直接复用(拿端口);exists 但 stopped → start 拉起;不存在 → run 新建。
      const state = await podman(['inspect', containerName, '--format', '{{.State.Status}}']).catch(() => '');
      if (state === 'running') {
        log?.info('recorder.vnc.container_reused', { status: 'ok', stage: containerName });
      } else if (state) {
        // 容器存在但已停(created/exited)→ 启动它,保留其端口映射与 user-data(登录态/录制环境)。
        await podman(['start', containerName], 30000);
        log?.info('recorder.vnc.container_restarted', { status: 'ok', stage: containerName });
      } else {
        // -P 随机映射宿主端口(避开端口冲突,如 macOS ControlCenter 占 7000);仅暴露 6080+7000。
        await podman(['run', '-d', '-P', '--name', containerName, IMAGE], 30000);
        log?.info('recorder.vnc.container_created', { status: 'ok', stage: containerName });
      }
      const vncPort = await hostPort(containerName, 6080);
      const gatewayPort = await hostPort(containerName, 7000);
      const deadline = Date.now() + READY_TIMEOUT_MS;
      // 两个独立就绪信号:画面面(noVNC vnc.html)+ 数据面(网关 /healthz)。
      await waitReady(`http://127.0.0.1:${gatewayPort}/healthz`, deadline);
      await waitReady(`http://127.0.0.1:${vncPort}/vnc.html`, deadline);
      const c: VncContainer = { containerName, vncPort, gatewayPort };
      containers.set(sessionId, c);
      log?.info('recorder.vnc.container_ready', { status: 'ok', stage: `${containerName} vnc=${vncPort} gw=${gatewayPort}` });
      return c;
    },

    async stop(sessionId) {
      const c = containers.get(sessionId);
      if (!c) return;
      containers.delete(sessionId);
      // 测试阶段:不删容器(下次 bind 复用,保留登录态/录制环境),只解除 be 内存映射。
      // BYCLI_VNC_REMOVE_ON_STOP=1 → 真正 podman rm -f(生产形态:一会话一容器,用完即删)。
      if (process.env.BYCLI_VNC_REMOVE_ON_STOP === '1') {
        await podman(['rm', '-f', c.containerName]).catch((e) => log?.warn('recorder.vnc.container_stop_failed', { status: 'error', stage: String(e) }));
        log?.info('recorder.vnc.container_removed', { status: 'ok', stage: c.containerName });
      } else {
        log?.info('recorder.vnc.container_kept', { status: 'ok', stage: `${c.containerName}(复用待命)` });
      }
    },

    async stopAll() {
      const all = [...containers.keys()];
      await Promise.all(all.map((id) => this.stop(id)));
    },
  };
}
