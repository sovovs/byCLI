#!/usr/bin/env bash
# 录制三端管理脚本
#   daemon : 浏览器底座(19825),由 bycli 管理;扩展连这口
#   be     : Recorder Local Service(19826),同源托管真实工作台 UI(dashboard/dist)
#   web    : Umi dev server(8000),mock 模式,仅前端开发用(无真实录制)
#
# 用法:
#   scripts/recorder.sh start   [daemon|be|all]       # 默认=真实录制环境(daemon+be,自动停 mock)
#   scripts/recorder.sh start   --mock                # 仅此参数才起 mock 前端(web :8000,假数据)
#   scripts/recorder.sh stop    [daemon|be|web|all]
#   scripts/recorder.sh restart [daemon|be|all]       # restart all=daemon+be(不含 mock);改了 .env/dist 后用
#   scripts/recorder.sh status                        # 看三端
#   scripts/recorder.sh build   [core|be|ui|ext|all] # 重建 dist(改源码后;all 含扩展,需手动重载)
#
# 真实录制(带 LLM)启动:scripts/recorder.sh start   → 打开 http://127.0.0.1:19826/workbench
#
# embedded_iframe 录制模式(P2,公开站页内嵌入;**本机默认开**):起 be 默认带 flag——
#   EMBEDDED=0 scripts/recorder.sh start              # 显式关闭页内嵌入模式
#   IFRAME_FRAME_SRC=https://juejin.cn scripts/recorder.sh restart be   # 只放该 origin(hardened)
#   inline env 经 `env VAR=…` 注入,优先级高于 --env-file(.env 不覆盖已存在的 process env)。
#
# vnc 录制模式(容器内 Chromium+扩展+daemon,noVNC 投画面;**本机默认开**,需 podman + 镜像):
#   scripts/recorder.sh build vnc                     # 构建容器镜像 bycli-verify:latest(需先 build ext + npm run build)
#   VNC=0 scripts/recorder.sh restart be              # 显式关闭 vnc 模式
#   选 VNC 模式后 be 自动 podman run 起容器、前端 iframe 投 noVNC 画面;录的数据走容器网关→be→合成链。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/.recorder-run"; mkdir -p "$RUN"
DAEMON_PORT=19825; BE_PORT=19826; WEB_PORT=8000

port_pid() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; }
alive()    { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# ───────────────────────── daemon(交给 bycli 管) ─────────────────────────
need_bycli() { command -v bycli >/dev/null || { echo "✗ bycli 不在 PATH(在仓库根 npm link)"; return 1; }; }
daemon_start()   { need_bycli || return 1; bycli daemon start   2>&1 | tail -1; }
daemon_stop()    { need_bycli && { bycli daemon stop 2>&1 | tail -1; } || true; }
daemon_restart() { need_bycli || return 1; bycli daemon restart 2>&1 | tail -1; }
daemon_status()  { local p; p="$(port_pid $DAEMON_PORT)"; [ -n "$p" ] && echo "● daemon  RUNNING  :$DAEMON_PORT  pid=$p" || echo "○ daemon  stopped  :$DAEMON_PORT"; }

# ───────────────────────── be(node 进程,PID 文件) ──────────────────────
be_start() {
  [ -f "$ROOT/dashboard-be/dist/server.js" ] || { echo "✗ be 未构建 → scripts/recorder.sh build be"; return 1; }
  [ -f "$ROOT/dashboard-be/.env" ]           || { echo "✗ 缺 dashboard-be/.env → cp dashboard-be/.env.example dashboard-be/.env 并填值"; return 1; }
  [ -d "$ROOT/dashboard/dist" ]              || echo "⚠ dashboard/dist 不存在,be 将 API-only(无 UI)→ scripts/recorder.sh build ui"
  if [ -n "$(port_pid $BE_PORT)" ]; then echo "● be 已在 :$BE_PORT(先 stop/restart)"; return 0; fi
  # embedded_iframe 模式(P2):EMBEDDED=1 → 注入 flag 开 frame-src + 前端模式选项。
  # 经 `env VAR=…` 内联注入,优先级高于 --env-file(.env 不覆盖已存在的 process env)。
  # 三种录制模式默认全开(本机录制工作台);显式 EMBEDDED=0 / VNC=0 可单独关。
  # 注:只在本机 be 启动注入,不动 recorder-core 的 fail-closed 发布默认(全局 CSP 安全底线不变)。
  local envv=()
  if [ "${EMBEDDED:-1}" = 1 ]; then
    envv+=(FEATURE_EMBEDDED_IFRAME_RECORDING=1)
    [ -n "${IFRAME_FRAME_SRC:-}" ] && envv+=("RECORDER_IFRAME_FRAME_SRC=$IFRAME_FRAME_SRC")
    echo "  ⚙ embedded_iframe 模式 ON${IFRAME_FRAME_SRC:+(frame-src=$IFRAME_FRAME_SRC)}"
  fi
  if [ "${VNC:-1}" = 1 ]; then
    envv+=(FEATURE_VNC_RECORDING=1)
    echo "  ⚙ vnc 容器模式 ON(be 自动 podman run bycli-verify:latest;需先 build vnc)"
  fi
  ( cd "$ROOT" && nohup env ${envv[@]+"${envv[@]}"} node --env-file=dashboard-be/.env dashboard-be/dist/server.js >"$RUN/be.log" 2>&1 & echo $! >"$RUN/be.pid" )
  sleep 1; be_status; echo "  日志: $RUN/be.log"
}
be_stop() {
  # 端口权威:pid 文件 + 实际占 19826 的进程都杀(防重复实例残留)
  local stopped=0 pf; pf="$(cat "$RUN/be.pid" 2>/dev/null)"
  for pid in "$pf" "$(port_pid $BE_PORT)"; do
    if alive "$pid"; then kill "$pid" 2>/dev/null; echo "✓ be 已停(pid=$pid)"; stopped=1; fi
  done
  [ "$stopped" = 0 ] && echo "○ be 未运行"
  rm -f "$RUN/be.pid"
}
be_restart() { be_stop; sleep 1; be_start; }
be_status()  { local p; p="$(port_pid $BE_PORT)"; [ -n "$p" ] && echo "● be      RUNNING  http://127.0.0.1:$BE_PORT/workbench  pid=$p" || echo "○ be      stopped  :$BE_PORT"; }

# ───────────────────────── web(Umi dev,mock) ───────────────────────────
web_start() {
  if [ -n "$(port_pid $WEB_PORT)" ]; then echo "● web 已在 :$WEB_PORT"; return 0; fi
  ( cd "$ROOT/dashboard" && nohup npm run dev >"$RUN/web.log" 2>&1 & echo $! >"$RUN/web.pid" )
  echo "✓ web 启动中(mock,http://127.0.0.1:$WEB_PORT)  日志: $RUN/web.log"
}
web_stop() {
  local pid; pid="$(cat "$RUN/web.pid" 2>/dev/null)"; [ -z "$pid" ] && pid="$(port_pid $WEB_PORT)"
  if alive "$pid"; then pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; echo "✓ web 已停"; else echo "○ web 未运行"; fi
  rm -f "$RUN/web.pid"
}
web_restart() { web_stop; sleep 1; web_start; }
web_status()  { local p; p="$(port_pid $WEB_PORT)"; [ -n "$p" ] && echo "● web     RUNNING  http://127.0.0.1:$WEB_PORT (mock)  pid=$p" || echo "○ web     stopped  :$WEB_PORT (mock dev)"; }

# ───────────────────────── build ────────────────────────────────────────
do_build() {
  case "${1:-all}" in
    core) npm --prefix "$ROOT/packages/recorder-core" run build ;;
    be)   npm --prefix "$ROOT/dashboard-be" run build ;;
    ui)   ( cd "$ROOT/dashboard" && npm run build ) ;;
    ext)  ( cd "$ROOT/extension" && npm run build ) ;;
    vnc)  # VNC 录制模式容器镜像(Chromium+扩展+daemon+x11vnc+websockify+网关);be 起容器时复用 bycli-verify:latest。
          command -v podman >/dev/null || { echo "✗ podman 不在 PATH(VNC 模式需 podman)"; return 1; }
          [ -f "$ROOT/extension/dist/background.js" ] || { echo "✗ 扩展未构建 → scripts/recorder.sh build ext"; return 1; }
          [ -f "$ROOT/dist/src/daemon.js" ]            || { echo "✗ dist 未构建 → npm run build"; return 1; }
          echo "▶ 构建 VNC 容器镜像 bycli-verify:latest(首次装 chromium 较慢)…"
          ( cd "$ROOT" && podman build -f podman-verify/Dockerfile -t bycli-verify:latest . ) ;;
    all)  npm --prefix "$ROOT/packages/recorder-core" run build \
            && npm --prefix "$ROOT/dashboard-be" run build \
            && ( cd "$ROOT/dashboard" && npm run build ) \
            && ( cd "$ROOT/extension" && npm run build ) \
            && echo "↻ 扩展已重建 → chrome://extensions 重载 byCLI(确认版本号刷新)" ;;
    *) echo "build: core|be|ui|ext|vnc|all"; return 1 ;;
  esac
}

# ───────────────────────── dispatch ─────────────────────────────────────
action="${1:-}"; shift || true
case "$action" in
  start)
    # mock 仅在显式 --mock 时启动;其余参数视作服务名
    mock=0; svcs=()
    for a in "$@"; do if [ "$a" = "--mock" ]; then mock=1; else svcs+=("$a"); fi; done
    if [ "$mock" = 1 ]; then
      echo "▶ 启动【mock 前端】(web :$WEB_PORT,假数据,无真实录制)"
      web_start
    elif [ ${#svcs[@]} -eq 0 ]; then
      # 默认 = 真实录制环境:停掉 mock web(防 :8000 误测)→ 起 daemon + be
      echo "▶ 启动【真实录制环境】(daemon + be);mock web 若在跑将被停掉以免混淆"
      [ -n "$(port_pid $WEB_PORT)" ] && web_stop
      daemon_start; be_start
      echo; echo "✅ 真实录制 → http://127.0.0.1:$BE_PORT/workbench(mock 需 start --mock)"
    else
      [ "${svcs[0]}" = "all" ] && svcs=(daemon be)
      for t in "${svcs[@]}"; do
        case "$t" in
          daemon|be) "${t}_start" ;;
          web) echo "✗ web 是 mock,请用:scripts/recorder.sh start --mock" ;;
          *) echo "未知服务: $t(daemon|be|all,mock 用 --mock)" ;;
        esac
      done
    fi ;;
  stop|restart)
    # all 语义:restart 只起真实环境(daemon+be,不复活 mock,与 start 默认一致);
    #          stop 则全停(含 mock web,teardown)。mock 启停一律显式 web/--mock。
    if [ $# -eq 0 ]; then targets=(daemon be)
    elif [ "${1:-}" = all ]; then
      [ "$action" = stop ] && targets=(daemon be web) || targets=(daemon be)
    else targets=("$@"); fi
    [ "$action" = stop ] && targets=($(printf '%s\n' "${targets[@]}" | tail -r 2>/dev/null || printf '%s\n' "${targets[@]}"))
    for t in "${targets[@]}"; do
      case "$t" in daemon|be|web) "${t}_${action}" ;; *) echo "未知服务: $t(daemon|be|web|all)";; esac
    done ;;
  status)
    daemon_status; be_status; web_status ;;
  build)
    do_build "${1:-all}" ;;
  ""|-h|--help|help)
    awk 'NR>1 && /^#/{sub(/^# ?/,"");print;next} NR>1{exit}' "${BASH_SOURCE[0]}" ;;
  *)
    echo "未知命令: $action(start|stop|restart|status|build)"; exit 1 ;;
esac
