# 译链｜众人共译平台

译链把文章按句子、段落或章节拆成任务单元，按文章配置把每个任务单元分配给多位注册志愿者。译者在移动端看到原文和大模型预译，可提交自己的译文；管理员按志愿者分组审核、采纳或退回重译，并查看任务单元、人员、采纳和审计报表。

## 项目结构

- `frontend/`：React + Vite H5 和管理员后台，适配手机与微信内置浏览器。
- `backend/`：Node.js + Express，支持 DOCX/TXT 导入、MySQL/SQLite、Redis 预翻译队列、腾讯 COS、PII 加密、审核版本和报表。
- `deploy/`：生产 Compose、MySQL/Redis/COS 配置模板、健康检查、模型检查、镜像发布和离线归档脚本。

生产 0.2.2 使用 MySQL `replace-with-database-name`、内网 Redis DB 20、腾讯 COS 和模型主备网关；本机模拟环境通过 Compose `simulation` profile 使用独立 SQLite/Redis/MinIO，不会污染生产数据。完整运维步骤见 [deploy/README.md](deploy/README.md)。

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

模型繁忙、429、5xx 和超时会自动按 Retry-After 和指数退避重试；主通道达到重试上限或出现鉴权、余额、模型未授权等错误时，会在同一次请求中自动切换备用通道，人工翻译仍可继续。部署前分别执行 `deploy/scripts/check-model.sh` 验证两个通道。

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
IMAGE_BUNDLE_TAG=0.2.2 ENV_FILE=.env bash scripts/prepare-offline-bundle.sh
IMAGE_BUNDLE_TAG=0.2.2 ENV_FILE=.env bash scripts/start-offline.sh
```

模拟环境入口为 `http://localhost:18082/simulation/`，启动方式见 [deploy/simulation/README.md](deploy/simulation/README.md)。

## 关键接口

| 场景 | 接口 |
| --- | --- |
| 存活/就绪 | `GET /api/health`、`GET /api/readyz` |
| 志愿者注册/会话 | `POST /api/auth/register`、`GET /api/auth/session` |
| 管理员登录 | `POST /api/admin/auth/login` |
| Word/TXT 导入 | `POST /api/admin/articles/import` |
| 配置每个任务单元人数 | `PATCH /api/admin/articles/:articleId/config` |
| 定向分配 | `POST /api/admin/articles/:articleId/assign` |
| 志愿者任务/提交 | `GET /api/users/:userId/tasks`、`POST /api/assignments/:assignmentId/submit` |
| 审核/历史 | `GET /api/admin/translations`、`POST /api/admin/translations/:translationId/review` |
| 报表/审计 | `GET /api/admin/reports`、`GET /api/admin/audit-logs` |

## 微信接入

H5 可放到公众号菜单或网页授权页；小程序接入时，把微信 `openid` 绑定到注册账号，再替换会话层即可，任务单元、审核和报表接口保持不变。实名、短信和银行卡四要素接口保留为独立适配层，待供应商接口申请完成后接入。
