# 翻译平台生产部署包

这个包对应小规模生产试跑：H5、管理员后台和异步预翻译在三个容器中运行，业务数据写入腾讯云 MySQL，原始 Word/TXT 写入腾讯云 COS，Redis 使用机房内网共享实例。现有 SQLite 只保留给本机模拟环境，生产 Compose 不会启动 PostgreSQL、Redis 或 MinIO 容器。

## 1. 生产依赖

| 组件 | 生产地址/配置 | 作用 |
| --- | --- | --- |
| MySQL | 内网 `replace-with-mysql-host:3306`，库 `replace-with-database-name` | 用户、文章、句段、译文、审核和审计 |
| MySQL 维护入口 | 外网 `replace-with-maintenance-mysql-host:23778`（公司办公网白名单） | 运维迁移、备份和故障处理 |
| Redis | `replace-with-redis-host:6379`，DB `20` | 预翻译队列和去重租约 |
| COS | `replace-with-cos-bucket`，区域 `ap-guangzhou` | 原始文件和签名下载 |
| 模型 | Sinohealth OpenAI 兼容接口 + 智谱 BigModel 主备 | `plmf/glm-5.3-flash` / `glm-5.3-flash` 预翻译 |

应用启动时使用 `CREATE TABLE IF NOT EXISTS` 初始化 MySQL 表和索引；不会清空已有数据。MySQL 连接由一个同步兼容层串行执行现有业务事务，连接池参数默认 10，适合当前 10 人试跑；扩容前应把数据库访问层改成原生异步并做压测。

## 2. 首次部署

服务器需要 Docker Engine 24+、Compose v2，并能访问内网 MySQL、Redis、COS 和模型网关。联网拉取镜像或使用离线归档均可。

```bash
cd translation-platform/deploy
cp .env.example .env
chmod 600 .env
```

在 `.env` 中填入以下私密字段：`ADMIN_KEY`、`PII_ENCRYPTION_KEY`、`MYSQL_PASSWORD`、`REDIS_PASSWORD`、`REDIS_URL`、`COS_ACCESS_KEY`、`COS_SECRET_KEY`、`OPENAI_COMPATIBLE_API_KEY`、`BIGMODEL_API_KEY`。已有数据库升级必须保留原 `PII_ENCRYPTION_KEY`，否则历史身份证号和银行卡号无法解密。

生产应用使用内网 MySQL：

```dotenv
DB_ENGINE=mysql
MYSQL_HOST=replace-with-mysql-host
MYSQL_PORT=3306
MYSQL_DATABASE=replace-with-database-name
MYSQL_USER=replace-with-database-name
MYSQL_PASSWORD=由密钥管理系统注入
```

外网地址只用于公司办公网白名单内的迁移或备份脚本，不要填入应用容器的 `MYSQL_HOST`。

生产 Redis URL 的密码需要 URL 编码；例如密码中有 `@` 时，`REDIS_URL` 使用 `%40`，但 `REDIS_PASSWORD` 仍保留原值：

```dotenv
REDIS_URL=redis://:密码URL编码后@replace-with-redis-host:6379/20
```

COS 使用 S3 兼容签名端点，公开基址只用于展示/运维：

```dotenv
COS_BASE_URL=https://replace-with-cos-host
COS_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
COS_BUCKET=replace-with-cos-bucket
COS_REGION=ap-guangzhou
S3_FORCE_PATH_STYLE=false
```

模型配置如下，默认先走 Sinohealth，失败后切换到智谱 BigModel：

```dotenv
LLM_PROVIDER_CHAIN=openai_compatible,bigmodel
LLM_PROVIDER=openai_compatible # 兼容旧配置；设置链后以 LLM_PROVIDER_CHAIN 为准
OPENAI_COMPATIBLE_BASE_URL=https://provider.example.invalid/v2/openai/completions
OPENAI_COMPATIBLE_MODEL=plmf/glm-5.3-flash
OPENAI_COMPATIBLE_API_KEY=由密钥管理系统注入
BIGMODEL_BASE_URL=https://bigmodel.example.test/api/coding/paas/v4/chat/completions
BIGMODEL_MODEL=glm-5.3-flash
BIGMODEL_KEY_TYPE=coding_plan
BIGMODEL_API_KEY=由密钥管理系统注入
```

主通道发生超时、429、5xx、网关繁忙/过载、鉴权或配额错误时，系统会先完成该通道自己的有限重试，再在同一次预翻译请求的总超时预算内切换备用通道。备用通道也会独立记录冷却时间、重试次数和错误指标；两个通道都不可用时才把任务标记为失败，志愿者仍可人工提交。`/api/health`、`/api/readyz` 和 `/api/admin/metrics` 会返回主通道及备用通道的脱敏配置状态。

每个通道可以单独调整运行参数，变量名使用供应商前缀，例如 `OPENAI_COMPATIBLE_RETRY_ATTEMPTS`、`BIGMODEL_REQUEST_TIMEOUT_MS`、`BIGMODEL_FAILURE_COOLDOWN_MS`；未设置时继承对应的 `LLM_*` 全局值。某通道耗尽临时故障重试后会进入短暂熔断冷却，冷却期间新请求直接尝试下一通道，避免 10 人并发时持续冲击故障网关；`Retry-After` 仍作为冷却时间下限。鉴权、余额、模型权限和参数错误不会热重试，但会记录通道状态并立即转入备用通道。

启动并验收：

```bash
docker compose --env-file .env config --quiet
docker compose --env-file .env pull backend frontend nginx
docker compose --env-file .env up -d --no-build --wait --wait-timeout 180
ENV_FILE=.env bash scripts/healthcheck.sh
ENV_FILE=.env bash scripts/check-model.sh
```

`/api/readyz` 会执行数据库查询，并确认模型配置、Redis worker 和对象存储配置；它不会调用模型接口。`check-model.sh` 才会使用真实 Key 对一条合成短句调用模型。

## 3. 模型繁忙与重试

所有模型调用共享并发上限，默认 `LLM_MAX_CONCURRENCY=2`。HTTP 429、5xx、超时、网关返回的 busy/overload/capacity 会遵守 `Retry-After`，按通道自己的 `*_RETRY_ATTEMPTS`（未设置则使用 `LLM_RETRY_ATTEMPTS`）、指数退避和总超时预算自动重试；鉴权、余额、模型未授权和参数错误会停止当前通道重试并转入备用通道。Redis 任务也有持久化重试时间，重启后会恢复，不会把原文写成伪译文。

Sinohealth 主通道已经完成模型授权时，将它作为生产首选通道。部署机必须重新执行 `check-model.sh`，确认返回 `ok: true`、`provider: openai_compatible`、`model: plmf/glm-5.3-flash`；命令只打印脱敏结果和短句译文，不会打印 API Key。若通道返回 429、5xx、超时或网关繁忙，适配器会按当前通道的重试参数退避，并在同一次请求中切换到已配置的 BigModel 备用通道。

```bash
cd translation-platform/deploy
ENV_FILE=.env bash scripts/check-model.sh
# 查看主备配置是否生效（只返回脱敏状态）
curl -fsS http://127.0.0.1/api/health | jq '.model, .modelFallback'
```

Sinohealth 的兼容 OpenAI 配置保持如下值，不要把 Coding Plan 的 `coding_plan` Key 类型填到这个端点：

```dotenv
LLM_PROVIDER_CHAIN=openai_compatible,bigmodel
OPENAI_COMPATIBLE_KEY_TYPE=platform_api
OPENAI_COMPATIBLE_BASE_URL=https://provider.example.invalid/v2/openai/completions
OPENAI_COMPATIBLE_MODEL=plmf/glm-5.3-flash
OPENAI_COMPATIBLE_API_KEY=由密钥管理系统注入
```

如果只启用 Sinohealth，可以把链设置为 `LLM_PROVIDER_CHAIN=openai_compatible`；生产建议同时配置 BigModel 和 `BIGMODEL_KEY_TYPE=coding_plan` 作为故障备用。不要把两个供应商的 Key 互换，适配器会根据端点和 Key 类型拒绝跨供应商转发。

## 4. 本机模拟环境

模拟环境仍使用独立 SQLite、Redis 和 MinIO，不污染生产 MySQL/COS。需要本机体验时：

```bash
cd translation-platform
docker compose --profile simulation -p translation-platform-simulation \
  --env-file deploy/simulation/.env \
  -f deploy/docker-compose.yml \
  -f deploy/simulation/compose.override.yml \
  up -d --pull never --no-build --wait --wait-timeout 180
```

入口为 `http://localhost:18082/simulation/`。模拟注册会直接落库，文章分配、多人翻译、审核退回和重提都通过同一数据库同步；模拟环境不使用生产 MySQL、Redis 或 COS。

## 5. 尽量离线部署

离线包只需要三个应用镜像（backend、frontend、nginx），因为生产 MySQL、Redis 和 COS 是外部托管服务。联网构建机先登录镜像仓库、拉取或构建已经验收的 0.2.4 镜像，然后生成归档：

```bash
cd translation-platform/deploy
IMAGE_BUNDLE_TAG=0.2.4 ENV_FILE=.env bash scripts/prepare-offline-bundle.sh
```

把 `offline/translation-platform-images-0.2.4.tar.gz`、对应 `.sha256`、`.manifest.txt`、`docker-compose.yml`、`.env` 和 `scripts/` 交给运维。机房机器无需访问镜像仓库：

```bash
cd translation-platform/deploy
IMAGE_BUNDLE_TAG=0.2.4 ENV_FILE=.env bash scripts/start-offline.sh
```

脚本会先校验 SHA-256，再 `docker load`，以 `--pull never --no-build` 启动。离线只针对镜像分发；业务运行仍需访问内网 MySQL/Redis、COS 和模型网关。若机房完全隔离外网，需为模型网关和 COS 准备网络出口或企业代理。

## 6. 备份、升级与回滚

MySQL 是生产真源，备份使用白名单网络上的 `mysqldump`，并把备份文件加密后放到独立存储。不要用 `docker compose down -v`，它会删除本机模拟卷。升级前：

```bash
docker compose --env-file .env exec backend node -e "console.log('backend ready')"
# 在允许访问 MySQL 外网地址的维护机执行 mysqldump（不要把密码写进命令行）
docker compose --env-file .env pull backend frontend nginx
docker compose --env-file .env up -d --no-build --wait --wait-timeout 180
ENV_FILE=.env bash scripts/healthcheck.sh
```

回滚只替换 `BACKEND_IMAGE`、`FRONTEND_IMAGE` 和 `NGINX_IMAGE` 为已经验收的旧版本，保留数据库、COS 对象和 `PII_ENCRYPTION_KEY`。应用表迁移是向前兼容的，回滚前要确认旧镜像能读取新增列。

## 7. 微信入口和医生端网页登录

医生端复用移动 H5 的志愿者工作区，登录、注册、领取任务和提交译文都在同一个 HTTPS 页面完成。医生端固定入口为：

```text
https://<H5业务域名>/doctor?entry=doctor&channel=public-account
```

`workspace=translator` 必须保留；`entry` 只是来源标记，可使用 `official-account` 或 `miniprogram`，后端会忽略未知查询参数。管理员后台使用 `?workspace=admin`，不要把管理员地址挂到公众号或小程序菜单。

### 公众号自定义菜单

1. 为实际 H5 主域名配置有效 HTTPS 证书；如果启用公众号 OAuth，再到“设置与开发 → 公众号设置 → 功能设置”配置网页授权域名（只填主域名，不带协议、端口和路径）。
2. 在“内容与互动 → 自定义菜单”新增菜单，类型选择“跳转网页”，页面地址填：

   ```text
   https://<H5业务域名>/?workspace=translator&entry=official-account
   ```

3. 发布菜单后，用微信内置浏览器打开链接，确认注册页、登录态和任务列表均能加载；不要使用 `http://`、内网 IP 或带端口的地址。

当前版本使用 H5 自己的注册/会话 Cookie。若后续需要公众号 OAuth 静默登录，在该入口增加 `code/state` 回调并在服务端绑定 `openid`，不改变任务、审核和报表接口；`state` 必须校验且只能在 HTTPS 下交换。

### 小程序 `web-view`

1. 在小程序后台“开发 → 开发管理 → 开发设置”将 H5 主域名加入“业务域名”，域名必须是 HTTPS，证书链完整，不能使用 localhost、IP、临时域名或非 443 端口。
2. 小程序页面使用 `web-view` 打开同一医生端地址，推荐通过页面参数传入完整 URL：

   ```text
   https://<H5业务域名>/?workspace=translator&entry=miniprogram
   ```

3. 发布前在真机验证：首次注册、刷新后会话仍在、领取任务、提交译文和审核结果刷新均正常。H5 与 API 使用同源 `/api`，外层反向代理要保留 `Host`、`X-Forwarded-Proto: https` 和 Cookie，不要把 API 改成跨域裸 IP。

4. 若小程序需要将用户身份传给 H5，使用 `wx.login` 换取服务端会话后再打开 `web-view`；不要把 `session_key`、身份证号或银行卡号放在 URL。正式接入前须在服务端完成 `openid/unionid` 与译者账号绑定，并保留现有 HttpOnly Cookie 会话。

### 网关和安全检查

- 外层负载均衡只允许 HTTPS，回源到 Nginx 80 端口；`CORS_ORIGIN` 设置为实际 H5 域名，公众号和小程序不使用 `*`。
- 微信入口只展示医生/志愿者工作区；管理员继续使用单独的后台入口和管理员会话。
- 发布前检查 `curl -I https://<H5业务域名>/?workspace=translator` 返回 200，并在微信真机确认没有证书、域名白名单或 Cookie 阻断提示。

## 8. 运行安全

公众号和小程序入口必须使用 HTTPS；外层负载均衡终止 TLS 后，把同源流量转发到 Nginx 80 端口，并设置 `CORS_ORIGIN`。身份证号、银行卡号使用 `PII_ENCRYPTION_KEY` 加密，接口只返回掩码。管理员和志愿者是独立会话，后台文章、原文、审核和报表接口均需要管理员会话。实名服务接入前使用 `REGISTRATION_MODE=open` 只跳过格式校验并记录 `registration_bypass`；接入真实接口后切回 `standard` 并实现供应商回调，不要把当前状态当成实名通过。

详细上线检查见 [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)。
