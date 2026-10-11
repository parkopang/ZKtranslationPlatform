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

所有模型调用共享并发上限，默认 `LLM_MAX_CONCURRENCY=2`。HTTP 429、5xx、超时、网关返回的 busy/overload/capacity 会遵守 `Retry-After`，按 `LLM_RETRY_ATTEMPTS`、指数退避和总超时预算自动重试；鉴权、余额、模型未授权和参数错误会停止当前通道重试并转入备用通道。Redis 任务也有持久化重试时间，重启后会恢复，不会把原文写成伪译文。

本机对用户提供的 Sinohealth Key 已验证网关可访问并返回 HTTP 200；当前网关对 `plmf/glm-5.3-flash` 返回“智能体未授权或不可用”的业务错误。请在部署机执行 `check-model.sh`，若仍出现该错误，需要在模型服务商后台给该 Key 开通模型或确认模型标识，代码不会擅自切换到其他模型。

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

离线包只需要三个应用镜像（backend、frontend、nginx），因为生产 MySQL、Redis 和 COS 是外部托管服务。联网构建机先登录镜像仓库、拉取或构建已经验收的 0.2.2 镜像，然后生成归档：

```bash
cd translation-platform/deploy
IMAGE_BUNDLE_TAG=0.2.2 ENV_FILE=.env bash scripts/prepare-offline-bundle.sh
```

把 `offline/translation-platform-images-0.2.2.tar.gz`、对应 `.sha256`、`.manifest.txt`、`docker-compose.yml`、`.env` 和 `scripts/` 交给运维。机房机器无需访问镜像仓库：

```bash
cd translation-platform/deploy
IMAGE_BUNDLE_TAG=0.2.2 ENV_FILE=.env bash scripts/start-offline.sh
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

## 7. 运行安全

公众号和小程序入口必须使用 HTTPS；外层负载均衡终止 TLS 后，把同源流量转发到 Nginx 80 端口，并设置 `CORS_ORIGIN`。身份证号、银行卡号使用 `PII_ENCRYPTION_KEY` 加密，接口只返回掩码。管理员和志愿者是独立会话，后台文章、原文、审核和报表接口均需要管理员会话。实名服务接入前使用 `REGISTRATION_MODE=open` 只跳过格式校验并记录 `registration_bypass`；接入真实接口后切回 `standard` 并实现供应商回调，不要把当前状态当成实名通过。

详细上线检查见 [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)。
