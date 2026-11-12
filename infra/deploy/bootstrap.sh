#!/usr/bin/env bash
# Folder Relay 一键部署（不挑发行版）
#
# 支持：Ubuntu 20.04+ / Debian 11+ / Alibaba Cloud Linux 3 / Anolis / CentOS Stream 9+
#       Rocky / AlmaLinux / openEuler（apt 与 dnf/yum 两大系都能跑）
#
# 用法（root）：
#   bash bootstrap.sh --source /tmp/folder-relay.tar.gz
#   bash bootstrap.sh --repo https://github.com/WinsDuan/folder-relay.git --branch main
#   bash bootstrap.sh --domain sync.example.com         # 有已备案域名
#   bash bootstrap.sh --domain 1.2.3.4.sslip.io         # 无域名（注意大陆地域的备案/80 端口拦截）
#   bash bootstrap.sh --tunnel-token <CF_TUNNEL_TOKEN>  # 走 Cloudflare Tunnel，完全不需要入站 80/443
#
# 设计取舍：Node 与 Caddy 都用**官方静态二进制**装到 /usr/local，不走发行版仓库。
# 原因：阿里云/Anolis/CentOS 的源里没有新版 Node，Caddy 也没有稳定的 rpm 源，
# 依赖发行版仓库会让"换一台机器就装不上"。静态二进制只有一条代码路径，可复现。
set -euo pipefail

DOMAIN=""
SOURCE=""
REPO=""
BRANCH="main"
PORT="1234"
TUNNEL_TOKEN=""
QUICK_TUNNEL="0"
APP_DIR="/opt/folder-relay"
DATA_DIR="/var/lib/folder-relay"
ETC_DIR="/etc/folder-relay"
SERVICE_USER="relay"
NODE_MAJOR="24"
CADDY_VERSION="${CADDY_VERSION:-2.8.4}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --source) SOURCE="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="${2:-}"; shift 2 ;;
    --quick-tunnel) QUICK_TUNNEL="1"; shift 1 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行（sudo bash bootstrap.sh ...）" >&2
  exit 1
fi

log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fatal() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH="x64"; BIN_ARCH="amd64" ;;
  aarch64|arm64) NODE_ARCH="arm64"; BIN_ARCH="arm64" ;;
  *) fatal "不支持的架构：$ARCH（目前支持 x86_64 与 aarch64）" ;;
esac

# ---------------------------------------------------------------- 0. 包管理器
log "识别系统"
PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
elif command -v yum >/dev/null 2>&1; then PKG="yum"
else fatal "既没有 apt-get 也没有 dnf/yum，无法继续"; fi
. /etc/os-release 2>/dev/null || true
echo "发行版：${PRETTY_NAME:-unknown}   包管理器：$PKG   架构：$ARCH"

case "$PKG" in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates tar xz-utils openssl git ufw rsync >/dev/null
    ;;
  dnf|yum)
    "$PKG" install -y -q curl ca-certificates tar xz openssl git rsync >/dev/null 2>&1 \
      || "$PKG" install -y curl ca-certificates tar xz openssl git >/dev/null
    ;;
esac

# ---------------------------------------------------------------- 1. Node.js
log "准备 Node.js ${NODE_MAJOR}.x"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "${major:-0}" -ge 22 ]
}
if node_ok; then
  echo "已有 $(node -v)，沿用"
else
  # 官方静态包：从 latest-vN.x 的 SHASUMS 里取文件名，避免手写补丁版本号
  sums_url="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt"
  sums="$(curl -fsSL --max-time 30 "$sums_url")" || fatal "下载 Node 校验文件失败：$sums_url"
  file="$(printf '%s\n' "$sums" | awk -v a="linux-${NODE_ARCH}.tar.xz" '$2 ~ a"$" {print $2; exit}')"
  [ -n "$file" ] || fatal "在 SHASUMS256.txt 里找不到 linux-${NODE_ARCH}.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSL --max-time 300 "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$file" -o "$tmp/node.tar.xz" \
    || fatal "下载 $file 失败"
  ( cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c - >/dev/null ) \
    || fatal "Node 安装包校验失败（网络被劫持或截断？）"
  tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  install -d /usr/local/lib/nodejs
  cp -a "$tmp"/node-v* /usr/local/lib/nodejs/
  NODE_HOME="$(find /usr/local/lib/nodejs -maxdepth 1 -mindepth 1 -type d | head -n1)"
  for binary in node npm npx; do ln -sf "$NODE_HOME/bin/$binary" "/usr/local/bin/$binary"; done
  rm -rf "$tmp"
  echo "已安装 $(node -v)（$NODE_HOME）"
fi
node_ok || fatal "Node 仍不可用，请手动安装 Node >= 22.13 后重跑"
echo "Node $(node -v) / npm $(npm -v)"

# ---------------------------------------------------------------- 2. Caddy
log "准备 Caddy ${CADDY_VERSION}"
if command -v caddy >/dev/null 2>&1; then
  echo "已有 $(caddy version | head -n1)，沿用"
else
  tmp="$(mktemp -d)"
  url="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${BIN_ARCH}.tar.gz"
  curl -fsSL --max-time 300 "$url" -o "$tmp/caddy.tgz" || fatal "下载 Caddy 失败：$url"
  tar -xzf "$tmp/caddy.tgz" -C "$tmp" caddy
  install -m 755 "$tmp/caddy" /usr/local/bin/caddy
  rm -rf "$tmp"
  echo "已安装 $(caddy version | head -n1)"
fi
command -v caddy >/dev/null || fatal "Caddy 不可用"

# ---------------------------------------------------------------- 3. 账号与目录
log "准备运行账号与目录"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd -r -d "$DATA_DIR" -s /sbin/nologin "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$DATA_DIR" "$ETC_DIR"
install -d -o root -g root -m 755 "$APP_DIR"

# ---------------------------------------------------------------- 4. 代码
log "部署代码到 $APP_DIR"
if [ -n "$SOURCE" ]; then
  [ -f "$SOURCE" ] || fatal "找不到源码包: $SOURCE"
  tmp="$(mktemp -d)"
  tar -xzf "$SOURCE" -C "$tmp"
  inner="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$inner" ] || fatal "源码包为空"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude node_modules --exclude .git --exclude .artifacts "$inner/" "$APP_DIR/"
  else
    rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"; cp -a "$inner/." "$APP_DIR/"
  fi
  rm -rf "$tmp"
elif [ -n "$REPO" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  else
    rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
  fi
else
  fatal "需要 --source 或 --repo"
fi
chown -R root:root "$APP_DIR"

log "安装运行期依赖（npm ci --omit=dev）"
cd "$APP_DIR"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------- 5. 配置
log "生成/保留运行配置"
ENV_FILE="$ETC_DIR/env"
if [ ! -f "$ENV_FILE" ]; then
  TOKEN="$(openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48)"
  WORKSPACE="$(cat /proc/sys/kernel/random/uuid)"
  cat > "$ENV_FILE" <<EOF
# Folder Relay 运行配置（含令牌，权限 600）
LSW_BIND_PUBLIC=1
LSW_HOST=127.0.0.1
LSW_PORT=$PORT
LSW_TOKEN=$TOKEN
LSW_DOCUMENT_ID=$WORKSPACE
LSW_DB_PATH=$DATA_DIR/collaboration.sqlite3
LSW_DATA_DIR=$DATA_DIR
LSW_TRUST_PROXY=1
LSW_HEARTBEAT_MS=25000
LSW_EVENT_LOG_SIZE=4096
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "已生成新的令牌与工作区 ID"
else
  echo "沿用现有 $ENV_FILE"
fi
set -a; . "$ENV_FILE"; set +a

# ---------------------------------------------------------------- 6. 服务
log "写入 systemd 单元"
cat > /etc/systemd/system/folder-relay.service <<EOF
[Unit]
Description=Folder Relay collaboration server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $APP_DIR/apps/collab-server/src/server.mjs
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=15
LimitNOFILE=65536
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

# ---------------------------------------------------------------- 7. 入口
if [ "$QUICK_TUNNEL" = "1" ]; then
  log "配置 Cloudflare Quick Tunnel（无需域名、无需账号；地址在每次重启后会变）"
  if ! command -v cloudflared >/dev/null 2>&1; then
    curl -fsSL --max-time 300 \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${BIN_ARCH}" \
      -o /usr/local/bin/cloudflared || fatal "下载 cloudflared 失败"
    chmod 755 /usr/local/bin/cloudflared
  fi
  cloudflared --version
  cat > /etc/systemd/system/cloudflared.service <<EOF
[Unit]
Description=Cloudflare Quick Tunnel for Folder Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel --url http://127.0.0.1:$PORT
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  # 一行小工具：随时打印当前公网地址
  cat > /usr/local/bin/relay-url <<'EOS'
#!/usr/bin/env bash
# 打印 Cloudflare Quick Tunnel 当前的公网地址（重启后会变）
journalctl -u cloudflared --no-pager 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n1 \
  || echo "还没拿到地址，稍等几秒后重试：journalctl -u cloudflared -n 50"
EOS
  chmod 755 /usr/local/bin/relay-url
  systemctl daemon-reload
  systemctl enable --now cloudflared >/dev/null
  systemctl restart cloudflared
  systemctl disable --now caddy >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    QUICK_URL="$(/usr/local/bin/relay-url 2>/dev/null | head -n1)"
    case "$QUICK_URL" in https://*) break ;; esac
    sleep 1
  done
  SIGNAL="wss://${QUICK_URL#https://}"
  PUBLIC_HOST="${QUICK_URL#https://}"
  [ -n "${QUICK_URL:-}" ] || warn "还没拿到 trycloudflare 地址，稍后执行 relay-url 查看"
elif [ -n "$TUNNEL_TOKEN" ]; then
  log "配置 Cloudflare Tunnel（无需入站 80/443，绕开大陆地域的备案与端口拦截）"
  if ! command -v cloudflared >/dev/null 2>&1; then
    curl -fsSL --max-time 300 \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${BIN_ARCH}" \
      -o /usr/local/bin/cloudflared || fatal "下载 cloudflared 失败"
    chmod 755 /usr/local/bin/cloudflared
  fi
  cloudflared --version
  cat > /etc/systemd/system/cloudflared.service <<EOF
[Unit]
Description=Cloudflare Tunnel for Folder Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel run --token $TUNNEL_TOKEN
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now cloudflared >/dev/null
  systemctl restart cloudflared
  systemctl disable --now caddy >/dev/null 2>&1 || true
  SIGNAL="wss://<你在 Cloudflare 面板为这条隧道配置的域名>"
  PUBLIC_HOST="<Cloudflare 域名>"
else
  log "配置 Caddy 反向代理"
  if [ -z "$DOMAIN" ]; then
    PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org || curl -fsS --max-time 8 https://ifconfig.me || true)"
    if [ -n "$PUBLIC_IP" ]; then
      DOMAIN="${PUBLIC_IP}.sslip.io"
      warn "未指定 --domain，使用 sslip.io 免域名方案：$DOMAIN"
      warn "注意：大陆地域对未备案域名的 80 端口访问有拦截，Let's Encrypt 可能签不出证书。"
      warn "     大陆 ECS 更稳的做法是 --tunnel-token（Cloudflare Tunnel），或换香港/新加坡地域，或先完成 ICP 备案。"
    else
      fatal "无法探测公网 IP，请用 --domain 指定域名后重跑"
    fi
  fi
  TEMPLATE="$APP_DIR/infra/deploy/Caddyfile.template"
  [ -f "$TEMPLATE" ] || fatal "缺少 Caddyfile 模板: $TEMPLATE"
  install -d -o root -g root -m 755 /etc/caddy
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" "$TEMPLATE" > /etc/caddy/Caddyfile
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 /var/log/caddy
  if ! id caddy >/dev/null 2>&1; then
    useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null \
      || useradd -r -d /var/lib/caddy -s /sbin/nologin caddy
  fi
  install -d -o caddy -g caddy -m 750 /var/lib/caddy
  # 静态安装的 Caddy 没有官方 unit：只给绑定特权端口的能力，其余最小权限
  cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy (Folder Relay reverse proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  caddy validate --config /etc/caddy/Caddyfile >/dev/null || fatal "Caddyfile 校验失败"
  echo "Caddyfile 校验通过"
  SIGNAL="wss://$DOMAIN"
  PUBLIC_HOST="$DOMAIN"
fi

# ---------------------------------------------------------------- 8. 防火墙
log "配置本机防火墙（云厂商安全组请另行放行 22/80/443）"
case "$PKG" in
  apt)
    if command -v ufw >/dev/null 2>&1; then
      ufw allow 22/tcp >/dev/null 2>&1 || true
      ufw allow 80/tcp >/dev/null 2>&1 || true
      ufw allow 443/tcp >/dev/null 2>&1 || true
      ufw --force enable >/dev/null 2>&1 || true
      ufw status | sed -n '1,12p' || true
    fi
    ;;
  dnf|yum)
    if command -v firewall-cmd >/dev/null 2>&1; then
      systemctl enable --now firewalld >/dev/null 2>&1 || true
      for p in 22 80 443; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null 2>&1 || true; done
      firewall-cmd --reload >/dev/null 2>&1 || true
      firewall-cmd --list-ports || true
    fi
    ;;
esac

# ---------------------------------------------------------------- 9. 启动
log "启动服务"
systemctl enable --now folder-relay >/dev/null
if [ -z "$TUNNEL_TOKEN" ]; then
  systemctl enable --now caddy >/dev/null
  systemctl restart caddy >/dev/null
fi
sleep 2
for unit in folder-relay caddy cloudflared; do
  [ -f "/etc/systemd/system/$unit.service" ] || continue
  printf '%-14s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)"
done

# ---------------------------------------------------------------- 10. 自检
log "自检"
local_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/healthz" || true)"
printf '本机 /healthz -> %s（期望 200）\n' "$local_code"
[ "$local_code" = "200" ] || warn "服务端本机自检没通，看 journalctl -u folder-relay -n 50"
if [ -z "$TUNNEL_TOKEN" ]; then
  proxy_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "https://$DOMAIN/healthz" || true)"
  printf '经 Caddy https://%s/healthz -> %s\n' "$DOMAIN" "$proxy_code"
  if [ "$proxy_code" != "200" ]; then
    warn "反代暂时不通。常见原因：安全组没放行 80/443；或大陆地域未备案域名被拦（证书签不出）。"
    warn "  查证书签发：journalctl -u caddy -n 80 --no-pager | tail -40"
  fi
fi

# ---------------------------------------------------------------- 11. 输出
cat <<EOF

========================================================================
部署完成（云厂商控制台请确认安全组放行 22 / 80 / 443）

  在 VS Code 里填的服务器地址： $SIGNAL
  工作区 ID：                  $LSW_DOCUMENT_ID
  加入信息：                   https://$PUBLIC_HOST/join   （需带令牌；本机可 curl -H "Authorization: Bearer \$LSW_TOKEN"）

  服务管理：systemctl status folder-relay   /   systemctl restart folder-relay
  服务端日志：journalctl -u folder-relay -f
  数据目录：  $DATA_DIR     配置（含令牌）：$ENV_FILE

  下一步：
  1. 从你自己的电脑验证：curl -s https://$PUBLIC_HOST/healthz
  2. 在任意已连接机器上执行 LSW: Copy Join Link，把链接发给组员
========================================================================
EOF
