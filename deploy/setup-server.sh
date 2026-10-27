#!/usr/bin/env bash
# ===================================================================
#  LiveTranslate 服务器初始化脚本
#  在服务器上以 root 执行：  bash setup-server.sh
#  作用：创建部署目录、安装 Node.js、配置 systemd 服务、开放防火墙
# ===================================================================
set -euo pipefail

APP_USER="www"
APP_DIR="/opt/livetranslate"
PORT="${PORT:-8009}"

log()  { echo -e "\n\033[1;36m==> $*\033[0m\n"; }
warn() { echo -e "\033[1;33m[警告] $*\033[0m"; }
ok()   { echo -e "\033[1;32m[完成] $*\033[0m"; }

# ---------- 1. 系统信息 ----------
log "检查系统环境"
cat /etc/os-release | head -3
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac
ok "系统架构: $NODE_ARCH"

# ---------- 2. 安装 Node.js 20 ----------
log "安装 Node.js 20 (LTS)"
if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -d. -f1 | tr -d 'v')" -ge 20 ]; then
  ok "已安装 $(node -v)，跳过"
else
  curl -fsSL "https://nodejs.org/dist/latest-v20.x/node-v20.19.0-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    || { warn "Node.js 官方源不可达，尝试国内镜像"; \
         curl -fsSL "https://npmmirror.com/mirrors/node/latest-v20.x/node-v20.19.0-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz; }
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
  ok "Node.js 安装完成: $(node -v)"
fi

# ---------- 3. 创建运行用户 ----------
log "创建运行用户 $APP_USER"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd -r -s /bin/bash -d "$APP_DIR" "$APP_USER"
  ok "用户已创建"
else
  ok "用户已存在"
fi

# ---------- 4. 部署目录 ----------
log "创建部署目录 $APP_DIR"
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 755 "$APP_DIR"
ok "目录就绪"

# ---------- 5. systemd 服务 ----------
log "配置 systemd 服务 livetranslate"
cat > /etc/systemd/system/livetranslate.service <<EOF
[Unit]
Description=LiveTranslate - 实时语音翻译服务
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/current
Environment=NODE_ENV=production
Environment=PORT=$PORT
ExecStart=/usr/local/bin/node server/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
EnvironmentFile=-$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable livetranslate > /dev/null 2>&1 || true
ok "systemd 服务已配置（首次部署代码后执行 systemctl start livetranslate）"

# ---------- 6. 防火墙 ----------
log "配置防火墙"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp    > /dev/null 2>&1 || true
  ufw allow 8009/tcp > /dev/null 2>&1 || true
  ufw --force enable   > /dev/null 2>&1 || true
  ok "ufw 已放行 22 和 $PORT"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=22/tcp   > /dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=8009/tcp > /dev/null 2>&1 || true
  firewall-cmd --reload > /dev/null 2>&1 || true
  ok "firewalld 已放行"
else
  warn "未检测到 ufw/firewalld，请自行确认云服务器安全组已放行 $PORT 端口"
fi

# ---------- 7. 校验工具 ----------
log "检查部署工具"
for c in curl tar git; do
  command -v "$c" >/dev/null 2>&1 && ok "$c 已安装" || warn "$c 缺失，请先安装"
done

echo -e "\n\033[1;32m========================================\033[0m"
echo -e "\033[1;32m 服务器初始化完成！\033[0m"
echo -e "\033[1;32m========================================\033[0m"
echo ""
echo "下一步："
echo "  1. 把仓库代码部署到 $APP_DIR/current"
echo "  2. systemctl start livetranslate"
echo "  3. curl http://127.0.0.1:8009/api/health  验证"
echo ""
