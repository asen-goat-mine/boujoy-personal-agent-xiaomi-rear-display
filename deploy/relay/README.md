# Boujoy 加密中继部署

此目录只部署密文中转。Mac 仍运行模型、文件和记忆，手机运行 Boujoy 与已配对的 Phone Use。中继没有模型密钥、手机配对密钥、聊天正文或截图明文。

## 部署条件

一台 Linux 主机，已有 Docker Engine / Compose v2，使用服务器的**固定公网 IPv4**，无需另买域名。入站 TCP 80/443 可达，UDP 443 用于可选 HTTP/3。Caddy 自动签发公网证书，需要可持续写入的数据卷。只使用已授权的主机；本代码不会购买服务器或代开账户。不要把 Mac 的本版 loopback UI/API 端口（由 distribution.json 指定）、Phone Use 的 8443 或 ADB 端口映射到公网。

IP 分支使用固定版本 `caddy:2.11.7-alpine`，明确选择 Let's Encrypt 公网 ACME 与 `shortlived` profile；IP 证书有效期为 160 小时，需要让 Caddy 持续自动续期。该能力已由 [Let's Encrypt 正式提供](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)，本部署的实际签发和续期仍须在服务器验证。`Caddyfile.ip` 的 `default_sni` 处理未发送 SNI 的 IP 客户端，适用于容器位于 NAT 后的情况，依据 [Caddy 全局选项](https://caddyserver.com/docs/caddyfile/options#default-sni)与 [ACME issuer 配置](https://caddyserver.com/docs/caddyfile/directives/tls#acme)。它不关闭客户端的证书链或 IP SAN 校验，也不使用本地自签证书替代公网证书。

已有域名也兼容：A 记录应指向本机，若配置 AAAA，也必须指向可达的本机 IPv6。脚本根据首个参数自动选择域名或公网 IPv4 配置；拒绝私网、保留地址、非标准 IPv4 编码。本发布入口暂不接受 IPv6 字面地址。固定公网 IP 若更换，需要同步更新 Mac 和手机的中继地址配置。

1. 在 Mac 设置中配置 `wss://固定公网IPv4/v1/tunnel`，生成本机身份与路由凭据。此时手机尚未绑定，不会执行手机任务。
2. 仅复制 Mac 运行目录的 `remote/relay-routes.json` 到云主机。这是随机路由凭据的 SHA256 表，不是凭据原文。不要复制 state.json、gateway 私钥、Phone Use 目录或知识库。
3. 解压发布包，在主机运行：

   ```sh
   relay_public_ipv4='替换为服务器实际固定公网IPv4'
   ./deploy/relay/start.sh "$relay_public_ipv4" /absolute/path/relay-routes.json
   ```

   域名部署将首个参数替换为 `relay.example.com`，对应 Mac 的中继地址也使用该域名。

4. 启动脚本将公网地址、Caddy 配置文件选择、相对路由表路径、固定项目名 `boujoy-relay` 写入本目录的 `.env`（权限 `0600`）。为兼容现有配置，`BOUJOY_RELAY_DOMAIN` 字段在 IP 模式下也存放公网 IPv4；`BOUJOY_RELAY_CADDYFILE` 自动选择 `./Caddyfile.ip` 或 `./Caddyfile`。该文件不含路由令牌或私钥；路由哈希表单独放在 `config/routes.json`。脚本以原子替换更新配置并重建容器，使文件挂载不会继续持有旧路由表。所有发布目录使用同一项目名，从而沿用同一组 Caddy 证书卷。
5. 检查 `https://固定公网IPv4/healthz` 返回真实 Node relay 健康结果，验证客户端信任的证书 SAN 确实包含该 IP。安装签名 Boujoy Android APK，用桌面生成的一次性二维码或绑定文件完成绑定。
6. 按下方清单完成真实上线检查，再宣称异地可用。

## 两个发行版的独立部署

两版在 Mac 上的应用和数据可并存；当前 relay 部署脚本仍使用同一个 `boujoy-relay` Compose 项目名和 80/443 端口。要同时保留两版独立的手机聊天连接，请分别使用不同服务器及各自路由表；本说明不提供同机双 relay 部署。服务器已有另一版 relay 时，不直接重复运行部署脚本覆盖它。

## 运维与恢复

后续命令在发布包的 `deploy/relay` 目录运行，Compose 会从 `.env` 读取同一配置，不需要重新输入公网地址或令牌：

```sh
docker compose config --quiet
docker compose ps
docker compose logs --tail 100 relay caddy
docker compose restart
```

不要在运维 shell 另外导出冲突的 `COMPOSE_PROJECT_NAME`、`BOUJOY_RELAY_DOMAIN`、`BOUJOY_RELAY_ROUTES_FILE`、`BOUJOY_RELAY_CADDYFILE`；Compose 的环境变量优先于 `.env`。`start.sh` 本身会固定这四个值。路由表有变化时重新运行 `start.sh`，不能仅 `restart`：路由表是启动时读取的文件挂载，原子替换文件需要 `--force-recreate` 切换到新文件。脚本拒绝部署目标 `.env`、`config`、`config/routes.json` 的符号链接。

脚本先用暂存 `.env` 与路由表执行 `docker compose --env-file … config --quiet`，成功后才替换正式配置。预校验失败不改变现有两个文件，首次失败也不会留下正式配置。若后续 `up` 失败，配置可能已提交、部分容器可能已变更，脚本会明确非零退出并要求检查 `ps/logs`；它不宣称自动回滚容器或授权。

启动脚本不将正文或令牌写进 shell 历史。路由文件须保留当前设备与角色各自的哈希。新建 `config` 目录权限是 `0700`；哈希表权限为 `0444`，供容器非 root 用户读取文件挂载，它不能包含凭据原文。Docker 端只暴露 Caddy 80/443，relay 18843 只在内部网络；Caddy 数据卷保存公网 TLS 证书。

中继进程重启丢弃原连接及流，不重放旧 TLS 字节。Android/Mac 根据原消息 ID 核对结果，不从中继取“离线动作”。任务恢复仍由 Mac 的动作记录决定，撤销手机须在 Mac 完成。

## 首次上线必须采集的结果

- 发布包 SHA-256 和包内 `manifest.json`；主机 Docker / Compose 版本；实际 `docker compose config --quiet` 结果与容器状态。
- 使用固定 Caddy 镜像运行配置解析，例如在本目录执行 `docker compose run --rm --no-deps --entrypoint caddy caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile`。IP 配置结果必须包含唯一公网 ACME issuer、`shortlived` profile 和对应 IP 的 `default_sni`；解析通过仍不等于证书签发成功。
- 公网证书链、SAN、有效期及 Caddy 自动续期记录、HTTPS `/healthz` 结果。IP 模式尤其需要确认短期证书持续续期；保留 Caddy 数据卷，避免每次重启重新注册或签发。健康接口只证明 relay 进程可响应，空路由表也可能健康，不能代替已认证连接检查。
- Mac 和 Android 的两条物理连接（data、control），以及四种流 `chat`、`chat-control`、`phone-data`、`phone-control` 的实际往返结果。验证错误路由凭据无法连接，数据通道断开时独立控制通道仍可停止。TLS 身份核验与手机操作结果需在端点确认，中继字节转发成功本身不能证明端点已执行。
- Wi-Fi、移动网络和用户实际 VPN 下的手机读取、停止、重连；主机重启后的容器与证书恢复。中断后的任务应保持暂停并按原消息 ID 查账，不应自动重放动作。

## 镜像与回滚

首次成功部署和每次升级前，保存下列实际输出到部署记录：

```sh
docker compose images
docker inspect --format '{{.Image}}' "$(docker compose ps -q relay)"
docker inspect --format '{{.Image}}' "$(docker compose ps -q caddy)"
```

对两个返回的镜像 ID 分别运行 `docker image inspect <实际镜像ID>`，记录 ID、RepoDigests（本机构建镜像可能没有仓库摘要）及平台，并为上一成功版本打本地保留标签。不要在回滚窗口清理这些镜像。Caddy 固定版本为 `2.11.7-alpine`，但标签仍不能替代镜像 ID；`node:24-alpine` 也是可变标签，重新构建旧源码不保证获得原镜像。

回滚使用保存的上一版部署文件和已保留的镜像：在临时 Compose override 中为 relay、caddy 指定已记录镜像的保留标签，并设置 `pull_policy: never`，执行 `docker compose -f compose.yaml -f rollback.yaml up --no-build --force-recreate -d`。固定项目名仍须为 `boujoy-relay`，沿用当前有效公网地址及 IP/域名配置选择、当前已授权路由哈希及原有 Caddy 数据卷。不能为了回滚重新引入旧设备授权，也不要执行 `down -v` 删除证书卷。回滚后重新检查 HTTPS 与上述四种流。

历史基线记录：此前进行过本机真实 WebSocket + 内层 TLS 测试；启动脚本曾使用真实 `/bin/sh` 和受控 Docker 命令记录器验证配置持久化、权限与后续命令，记录器不运行容器。这些记录不代表本次 Phone Use/Xiaomi 公开发行版已经部署到云端。此前未完成真实 Caddy 配置解析、Linux 容器构建、镜像 ID、公网证书与上述上线清单；本次若无独立验收记录，同样必须标为未实测。`start.sh` 会先验证 Compose，再启动容器；本机测试不代替接收者的公网验收。

`node scripts/package-relay.mjs` 从新的临时目录打包固定 12 个源码与部署文件（包含两个 Caddy 配置），清单逐项记录 SHA-256。不会复用或归档旧 `dist/relay` 目录；曾放在其中的路由表或其他本地材料不会混入发布包。白名单源码路径出现符号链接时拒绝打包。
