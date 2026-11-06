# 测试版（staging）部署：在线上域名上验证 PR

## 背景

PR 里的语音识别改动必须在真实 Chrome / Edge 上用麦克风验证。浏览器只允许 HTTPS 页面调用麦克风，所以测试版要能通过 HTTPS 访问。为了不影响线上用户，测试版和线上版并行运行，各自使用独立的数据库。

## 方案

在同一台服务器上复用现有的域名和证书，nginx 根据 cookie 决定请求转发到哪个后端：

| | 线上版 | 测试版 |
| --- | --- | --- |
| 端口 | 8009 | 8010 |
| systemd 服务 | `livetranslate` | `livetranslate-staging` |
| 代码目录 | `/opt/livetranslate/current` | `/opt/livetranslate-staging/current` |
| 数据库 | `livetranslate` | `livetranslate_staging`（同一个 MariaDB 容器） |
| 环境变量 | `/opt/livetranslate/.env` | `/opt/livetranslate-staging/.env`（复制线上配置，只改 `DB_NAME`、`DATA_DIR`） |

- 打开 `https://translate.guoming576.cn/__staging`：写入 cookie `lt_stage=1`（有效期 7 天），之后这个浏览器的请求都转发到测试版。
- 打开 `https://translate.guoming576.cn/__prod`：清除这个 cookie，切回线上版。
- 每个响应都带 `X-LT-Stage: prod|staging` 响应头，在 DevTools 的 Network 面板里可以确认当前访问的是哪个版本。
- 没有这个 cookie 的访客不受任何影响。

nginx 改动位于 `/etc/nginx/conf.d/translate.guoming576.cn.conf`：文件顶部新增两个 `map`（`$lt_backend`、`$lt_stage_name`），新增 `location = /__staging` 和 `location = /__prod`，`location /` 的转发目标改为 `proxy_pass $lt_backend`。改动前的原文件备份在服务器的 `/root/nginx-backup/` 下。

## 账号

- 测试库的 `users` 表是从线上库复制过来的，所以可以用线上的用户名和密码登录。会话和消息数据不复制，测试版产生的记录只写入 `livetranslate_staging`。
- 登录 token 存在浏览器的 `localStorage`（`lt.token`）里，而测试版和线上版是同一个域名，会共用这个 token。在两个版本之间切换后需要重新登录一次。

## 更新测试版

在本地仓库的 PR 分支上执行：

```bash
git archive --format=tar.gz -o /tmp/lt-staging.tgz HEAD
scp /tmp/lt-staging.tgz root@<服务器>:/tmp/
ssh root@<服务器> '
  D=/opt/livetranslate-staging
  rm -rf $D/current.new && mkdir -p $D/current.new
  tar -xzf /tmp/lt-staging.tgz -C $D/current.new
  cd $D/current.new && PATH=/opt/node-current/bin:$PATH npm ci --omit=dev --no-audit --no-fund
  rm -rf $D/current && mv $D/current.new $D/current && chown -R www:www $D
  systemctl restart livetranslate-staging
  curl -s http://127.0.0.1:8010/api/health'
```

## 验证

```bash
curl -sI --cookie lt_stage=1 https://translate.guoming576.cn/api/health | grep -i x-lt-stage   # staging
curl -sI https://translate.guoming576.cn/api/health | grep -i x-lt-stage                       # prod
```

## 下线测试版

```bash
systemctl disable --now livetranslate-staging
rm /etc/systemd/system/livetranslate-staging.service && systemctl daemon-reload
# 用 /root/nginx-backup/ 下的备份恢复 nginx 配置，然后执行：
nginx -t && nginx -s reload
# 如果不再需要测试数据：DROP DATABASE livetranslate_staging;
```

## 已知限制

- 测试版和线上版共用同一个翻译出口（Bing/Google），会一起消耗配额。
- PR 合并到 `master` 后会自动部署线上版，但测试版不会跟着更新，需要按上面的步骤手动更新。
