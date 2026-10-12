# 生产就绪检查

## 已完成

- MySQL 适配：`DB_ENGINE=mysql`，自动建表/索引、重启幂等、审计/审核版本表完整保留；外网维护端点与内网应用端点分离。
- Redis：应用通过 `REDIS_URL` 使用共享内网 DB 20，预翻译任务有去重、持久化重试和重启恢复。
- COS：S3 兼容签名上传、文件 SHA-256、原文对象键和短时下载地址；COS 元数据使用兼容的连字符键。
- 模型：新增 OpenAI 兼容供应商，固定校验 Sinohealth 端点、`plmf/glm-5.3-flash` 模型和 Bearer Key；保留原 BigModel/MiniMax 适配但不会跨供应商转发 Key。
- 重试：网关繁忙、429、5xx、超时和 Retry-After 有界处理；永久鉴权/余额/模型授权错误不会热重试。
- 业务：注册资料、文章导入、每句协作人数、定向分配、多人提交、审核采纳/退回/重提、报表和审计全部落到 MySQL。
- 安全：生产容器只读根文件系统、能力裁剪、资源上限；PII 加密；Key 仅通过环境或密钥管理系统注入。
- 离线：0.2.6 归档只包含三个应用镜像，部署机不需要访问镜像仓库；外部依赖仍需内网访问。
- 微信入口：管理员可维护多个公众号/小程序入口，入口编码、渠道和启用状态随注册会话落库；志愿者、任务、审核、报表和审计支持按入口筛选。停用入口不会删除历史数据。

## 现场验收顺序

1. 在公司办公网确认外网 MySQL `replace-with-maintenance-mysql-host:23778` 可连接；应用服务器改用内网 `replace-with-mysql-host:3306`。
2. 使用只读 `SELECT 1` 验证 MySQL 账号，再启动 backend；启动日志不得出现 schema 或索引错误。
3. 用 `scripts/healthcheck.sh` 验证 `/api/health`、`/api/readyz`。就绪接口必须同时报告 database/model/queue/objectStorage 为 true。
4. 用 `scripts/check-model.sh` 对合成短句做一次真实调用，记录脱敏的 provider、model、错误类别和 trace id；不要把响应原文或 Key 写入日志。
5. 在后台注册两名以上志愿者，导入一份 TXT/Word，配置每句 2–3 人，完成分配、提交、退回、重提、采纳和报表核对。
6. 并行发起 10 个注册/领取/提交请求，确认同一句不超过配置人数、同一用户不重复分配，Redis 任务没有重复预译。
7. 上传一个合成 Word，确认 COS 对象存在、SHA-256 与数据库一致、管理员签名下载可用；删除测试对象。
8. 执行一次 MySQL dump 恢复演练，至少验证用户、句段、译文、审核版本和审计记录。
9. 在后台创建一个公众号入口和一个小程序入口，分别发布生成的链接；注册两个测试志愿者，确认注册页展示正确入口名称/渠道，后台按入口筛选结果与注册来源一致。
10. 停用其中一个入口，确认新访问不能注册、旧志愿者仍能登录查看历史任务；重新启用后链接恢复，入口编码和历史审计记录不变。

## 已执行的本机验证

- `npm run build`：通过。
- `npm test`：模型重试、建议持久化、冒烟、10 人并发、文章配置、审核工作流、会话隔离、注册分配和模型 API 回归全部通过。
- OpenAI 兼容适配器：验证 URL、模型、Bearer 鉴权、HTTP 503 busy 重试、响应脱敏。
- MySQL：外网维护地址 `SELECT 1` 通过，空库自动建表后执行插入/读取/删除往返通过；当前本机不在内网，`replace-with-mysql-host:3306` 超时符合网络隔离预期。
- COS：HeadBucket、上传、签名 URL 和测试对象清理通过。
- 真实模型：Sinohealth 已完成 `plmf/glm-5.3-flash` 授权时，现场验收必须返回 `ok: true`、`provider: openai_compatible` 和 `model: plmf/glm-5.3-flash`。若仍返回“智能体未授权或不可用”，先检查 Key 是否注入到运行中的 backend 容器、模型标识和端点路径，再联系服务商；不要用 BigModel 的 Coding Plan Key 调用 Sinohealth 端点。

## 仍需现场确认

- 在部署机使用最新 Key 重新执行 `scripts/check-model.sh`，确认 `plmf/glm-5.3-flash` 返回成功；如果后台模型标识不同，只更新 `OPENAI_COMPATIBLE_MODEL`，不要改代码绕过权限。
- 机房容器到 `replace-with-mysql-host`、`replace-with-redis-host`、COS 和模型网关的防火墙/白名单、DNS、TLS 和出口代理。
- 微信公众号自定义菜单跳转网页、小程序 `web-view` 业务域名、HTTPS 证书、Cookie 保持、真机注册/登录和外层限流；管理员入口管理需要为每个渠道生成独立的 `entry` 编码，医生端链接使用 `https://<H5业务域名>/?workspace=translator&entry=<入口编码>&channel=<public-account|mini-program>`。
- 入口安全需要现场确认：未知、停用或渠道不匹配的编码不能进入注册；入口编码不能替代 OAuth/`wx.login` 身份绑定；志愿者来源、任务和报表按入口筛选时不能串数据。
- PII 密钥托管、轮换、数据库最小权限、COS 私有读写策略、备份加密和恢复负责人。

## 10 人试跑容量边界

单个 backend 实例默认模型并发 2、预翻译 worker 2、MySQL 连接池 10。请求层有速率限制和事务约束，数据库适配层为了兼容现有同步业务 API 会串行执行 SQL；这能覆盖 10 人小规模试跑，但不能据此承诺更高吞吐。扩大到多副本或 10 人以上持续高频提交前，需压测并迁移到原生异步数据库访问、共享限流和集中监控。
