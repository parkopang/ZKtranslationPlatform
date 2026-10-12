# 译链｜众人共译平台

译链把文章按句子、段落或章节拆成任务单元，按文章配置把每个任务单元分配给多位注册志愿者。译者在移动端看到原文和大模型预译，可提交自己的译文；管理员按志愿者分组审核、采纳或退回重译，并查看任务单元、人员、采纳和审计报表。

## 项目结构

- `frontend/`：React + Vite H5 和管理员后台，适配手机与微信内置浏览器。
- `backend/`：Node.js + Express，支持 DOCX/TXT 导入、MySQL/SQLite、Redis 预翻译队列、腾讯 COS、PII 加密、审核版本和报表。
- `deploy/`：生产 Compose、MySQL/Redis/COS 配置模板、健康检查、模型检查、镜像发布和离线归档脚本。

生产镜像会使用已验收的版本标签（当前发布线为 0.2.6），连接 MySQL `replace-with-database-name`、内网 Redis DB 20、腾讯 COS 和模型主备网关；本机模拟环境通过 Compose `simulation` profile 使用独立 SQLite/Redis/MinIO，不会污染生产数据。完整运维步骤见 [deploy/README.md](deploy/README.md)。

## 本地开发

```bash
cd backend
npm ci
cp .env.example .env
npm run build
npm test
```

本地默认 `DB_ENGINE=sqlite`。需要启用队列时，将 `REDIS_URL` 指向本机 Redis；生产 MySQL 不应写入本机开发环境。前端：

```bash
cd frontend
npm ci
npm run dev
```

真实后端模式下，管理员从页面进入后台并输入 `ADMIN_KEY`；Key 只通过环境变量注入，不放到 `VITE_*` 前端构建参数。

## 业务规则

文章导入时可以选择按句子、段落或章节创建任务单元，再设置每个任务单元需要几位志愿者（1–20）；这个人数与每位志愿者每次领取 1–2 个任务相互独立。调高比例会开放未采纳任务单元的新名额，调低不会撤销已分配任务或删除译文。已采纳任务单元会关闭全部任务，其他候选显示为未采纳。

志愿者必须注册并取得服务端会话后才能领取、读取和提交任务。当前交付可用 `REGISTRATION_MODE=open` 暂时跳过资料格式校验，资料仍加密入库并标记 `registration_bypass`；接入真实实名接口后切回 `standard` 并将核验结果写入 `verification_status`。这两个模式都不会绕过登录。

审核退回必须填写修改意见；志愿者可在原任务中重提，历史版本、审核人和时间都会保留。审核和重提携带版本号，旧页面不能覆盖新版本。管理员与志愿者使用独立 HttpOnly Cookie，两端每 5 秒同步数据库状态。

微信入口由管理员在后台维护。每个公众号或小程序对应一个启用中的入口记录，包含入口名称、渠道类型、管理员填写的入口编码、跳转地址和状态；管理员可复制链接、停用入口或重新启用入口。入口编码随注册会话写入志愿者资料和审计记录，后台志愿者、任务分配、审核和报表均可按入口筛选。停用入口只阻止新的访问和注册，不删除已经产生的任务、译文和历史数据。志愿者注册页会展示“来自：入口名称 · 公众号/小程序”，注册后可在个人数据中查看来源。

## 生产模型配置

```dotenv
LLM_PROVIDER_CHAIN=openai_compatible,bigmodel
LLM_PROVIDER=openai_compatible
OPENAI_COMPATIBLE_BASE_URL=https://provider.example.invalid/v2/openai/completions
OPENAI_COMPATIBLE_MODEL=plmf/glm-5.3-flash
OPENAI_COMPATIBLE_API_KEY=由密钥管理系统注入
BIGMODEL_BASE_URL=https://bigmodel.example.test/api/coding/paas/v4/chat/completions
BIGMODEL_MODEL=glm-5.3-flash
BIGMODEL_KEY_TYPE=coding_plan
BIGMODEL_API_KEY=由密钥管理系统注入
```

模型繁忙、429、5xx 和超时会自动按 Retry-After 和指数退避重试；每个通道可以使用 `OPENAI_COMPATIBLE_*`、`BIGMODEL_*` 或 `MINIMAX_*` 覆盖重试、超时、并发和冷却参数。主通道达到重试上限会进入短暂熔断并在同一次请求中自动切换备用通道，人工翻译仍可继续。Sinohealth 授权成功后，部署使用 `OPENAI_COMPATIBLE_KEY_TYPE=platform_api`、`OPENAI_COMPATIBLE_BASE_URL=https://provider.example.invalid/v2/openai/completions` 和 `OPENAI_COMPATIBLE_MODEL=plmf/glm-5.3-flash`；部署前执行 `deploy/scripts/check-model.sh`，检查结果中的 `ok`、`provider` 和 `model`。

## 生产部署

```bash
cd deploy
cp .env.example .env
chmod 600 .env
# 填写 ADMIN_KEY、PII_ENCRYPTION_KEY、MySQL/Redis/COS/模型密钥
docker compose --env-file .env config --quiet
docker compose --env-file .env pull backend frontend nginx
docker compose --env-file .env up -d --no-build --wait --wait-timeout 180
ENV_FILE=.env bash scripts/healthcheck.sh
ENV_FILE=.env bash scripts/check-model.sh
```

生产应用使用内网 MySQL `replace-with-mysql-host:3306`，公司办公网络白名单的 `replace-with-maintenance-mysql-host:23778` 只用于维护和迁移。Redis 使用 `replace-with-redis-host:6379/20`，原始文件使用 COS。应用启动会幂等创建表和索引，不清空已有数据；生产备份使用 `mysqldump`，不要执行 `docker compose down -v`。

离线交付只需要 backend、frontend、nginx 三个应用镜像，外部 MySQL、Redis、COS 和模型网关仍需网络可达：

```bash
IMAGE_BUNDLE_TAG=0.2.6 ENV_FILE=.env bash scripts/prepare-offline-bundle.sh
IMAGE_BUNDLE_TAG=0.2.6 ENV_FILE=.env bash scripts/start-offline.sh
```

模拟环境入口为 `http://localhost:18082/simulation/`，启动方式见 [deploy/simulation/README.md](deploy/simulation/README.md)。

## 关键接口

| 场景 | 接口 |
| --- | --- |
| 存活/就绪 | `GET /api/health`、`GET /api/readyz` |
| 志愿者注册/会话 | `POST /api/auth/register`、`GET /api/auth/session` |
| 管理员登录 | `POST /api/admin/auth/login` |
| 微信入口配置 | `GET/POST/PATCH /api/admin/entries` |
| 注册入口回显 | `GET /api/auth/registration-config?entry=入口编码&channel=渠道` |
| Word/TXT 导入 | `POST /api/admin/articles/import` |
| 配置每个任务单元人数 | `PATCH /api/admin/articles/:articleId/config` |
| 定向分配 | `POST /api/admin/articles/:articleId/assign` |
| 志愿者任务/提交 | `GET /api/users/:userId/tasks`、`POST /api/assignments/:assignmentId/submit` |
| 审核/历史 | `GET /api/admin/translations`、`POST /api/admin/translations/:translationId/review` |
| 报表/审计 | `GET /api/admin/reports`、`GET /api/admin/audit-logs` |

## 微信接入

医生端直接复用移动 H5 的志愿者工作区。管理员为每个公众号和小程序创建独立入口并填写唯一编码后，后台提供带入口编码的 HTTPS 链接：

```text
https://<H5业务域名>/doctor?entry=<公众号入口编码>&channel=public-account
https://<H5业务域名>/doctor?entry=<小程序入口编码>&channel=mini-program
```

生产首页是 `https://<H5业务域名>/`；管理员首次进入首页后，从右上角管理入口输入部署时配置的 `ADMIN_KEY`，再进入 `/?workspace=admin`。本机模拟首页才是 `http://localhost:18082/simulation/`，页面截图和模拟快捷入口不代表生产首页。

公众号后台把 `<H5业务域名>` 加入网页授权域名后，在“自定义菜单”创建“跳转网页”菜单；小程序后台把同一域名加入“业务域名”，由 `web-view` 打开对应入口链接。域名必须有有效 HTTPS 证书，不能使用 IP、localhost、临时域名或非 443 端口。医生端使用 `/doctor` 入口，管理员后台仍使用独立的 `?workspace=admin`，不要把后台地址放进微信菜单。不要手工复制另一个公众号或小程序的入口编码。

当前 H5 使用服务端 HttpOnly Cookie 完成注册和登录，微信入口无需把身份证号、银行卡号或 `session_key` 放入 URL。注册配置接口会校验入口是否存在、启用且渠道匹配，并把入口名称、入口编码和渠道写入新志愿者记录；未知或停用入口不得继续注册。后续接入公众号 OAuth 或小程序 `wx.login` 时，在服务端将 `openid/unionid` 绑定现有译者账号，再创建同一会话；任务、审核和报表接口无需改动。完整的管理员配置、域名白名单、反向代理和真机验收步骤见 [deploy/README.md](deploy/README.md)。
