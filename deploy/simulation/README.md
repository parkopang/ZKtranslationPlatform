# 本机测试环境

入口：<http://localhost:18082/simulation/>。仅监听本机回环地址，适合在这台电脑体验。

首页为「协作工作空间」，提供翻译工作台和管理工作台两个入口。首次进入翻译工作台必须先填写注册表单；入口不再自动创建账号或领取任务。注册成功后可以等待后台分配，也可主动领取 1–2 句。再次进入时从数据库会话恢复同一账号。「注册新志愿者」仅退出当前志愿者会话后打开注册表单，不退出管理员。已导入 3 篇合成文章、18 句原文、3 位示例译者、6 份明确标注的人工测试提交和 1 条采纳记录。首页提供 3 个 Word 样例下载。

面向观众的页面不展示环境横幅、模型接入说明、管理员密钥或虚拟身份字段。操作页顶部通过「工作空间」返回入口。该调整只改变展示方式，本环境仍使用独立测试数据和本机快捷登录；这些入口不适用于公开的生产部署。

本环境调用真实的 `plmf/glm-5.3-flash`，使用用户提供的真实 Key 和 OpenAI 兼容端点；没有模拟模型服务或预填 AI 译文。Key 只在本目录权限为 600 的 `.env` 中，前端与测试镜像不含 Key。真实预译会使用套餐额度，失败时展示实际错误状态并保留人工翻译能力。

测试管理员密钥为 `Simulation-Admin-2026-Local-Only-001`，只适用于这个本机测试环境。页面提供快捷登录，通常无需手动输入。当前第三方实名核验尚未接入。此独立演示环境以 `SIMULATION_ENV=true` 开启宽松注册，资料可选且不做格式或真实性校验，允许重复手机号，账号直接开通；资料仍加密落库，核验来源记为 `registration_bypass`，不代表已通过第三方实名核验。生产环境默认继续使用原有注册校验。

## 运行与重启

保持 Docker 和本机现有代理运行。在项目根目录执行：

```bash
bash deploy/simulation/start.sh
```

数据保存在 Compose 项目 `translation-platform-simulation` 的独立数据卷中。重复执行启动脚本会保留已有测试记录；不会清空数据库或重建示例数据。与现有 18080、18081 两套环境使用独立数据卷、管理员密钥和中间件密码。推荐使用 `localhost` 地址，减少与其他 `127.0.0.1` 站点的同名 Cookie 相互覆盖。

## 本机模型网络适配

2026-10-08 排查发现：本机直连及系统 DNS 返回的智谱地址会在 TLS 阶段断开；通过当前系统 HTTP 代理及公开 DNS 返回的智谱节点可以正常访问。测试后端通过 `network.mjs` 使用 `http://host.lima.internal:7891`（本机系统代理端口）及 `.env` 的 `SIMULATION_MODEL_ADDRESS`。

请求 URL、Host、TLS SNI 和证书验证跟随 `SIMULATION_MODEL_ORIGIN`（当前为 `provider.example.invalid`）；代理只改变 CONNECT 的网络地址，不关闭证书验证，也不回退到其他模型。节点地址或本机代理改变时需重新验证并更新测试配置，不要将此本机适配直接复制到生产部署。

后端、前端及代理页面使用三个本地测试镜像 `translation-platform/test-backend:0.2.2`、`translation-platform/test-frontend:0.2.2`、`translation-platform/test-nginx:0.2.2`。因为当前 Docker 虚拟机无法读取此目录的主机挂载，测试资源已复制到专用镜像中。它们未上传正式镜像仓库；生产镜像和交付配置未被替换。

真实模型单句验证记录：`test-results/test-environment-live-key.json`。浏览器验收画面：`test-results/real-key-test-environment.png`。

## 更新入口页面

更新应用前后端时，先在 `backend/`、`frontend/`、`deploy/simulation/` 安装锁文件指定的本机依赖，再执行 `bash deploy/simulation/build.sh` 和 `bash deploy/simulation/start.sh`。脚本编译当前源代码，并用本地已有的固定摘要基础镜像构建三个测试镜像；镜像构建阶段无需下载依赖。后端 Linux 原生依赖沿用基础镜像，因此若应用依赖清单变化，必须先通过正式 Dockerfile 构建新的基础镜像并更新摘要。

页面资源已打入本机测试 Nginx 镜像，修改本目录的 `public/` 或 `nginx.conf` 后，在项目根目录执行：

```bash
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load --network none -f deploy/simulation/Dockerfile.nginx -t translation-platform/test-nginx:0.2.2 deploy/simulation
docker compose -p translation-platform-simulation --env-file deploy/simulation/.env -f deploy/docker-compose.yml -f deploy/simulation/compose.override.yml up -d --no-deps --no-build --pull never --wait --wait-timeout 120 nginx
```

构建使用 `Dockerfile.nginx` 中锁定的本地基础镜像，不改动后端、数据库或真实模型配置。2026-10-08 工作空间改版验收记录：`test-results/workspace-presentation.json`，最新画面：`test-results/workspace-presentation.png`。

## 文章管理升级验收

2026-10-08 已在本环境更新文章管理：进入管理工作台 → 文章管理 → 管理文章，可调整每句 1–20 位志愿者。保存前显示名额变化；调低仍保留既有任务和提交资格，采纳后同句全部任务结束并保留历史。

新版后端首次启动会补齐文章配置更新时间，并关闭历史已采纳句的任务；历史采纳后产生的遗留待审核译文改为未采纳，保留内容和原提交时间。升级前备份为 `deploy/backups/simulation-before-article-config-20261008.sqlite`。本次原有 14 个任务、11 份译文均保留。

浏览器验收导入了「社区共译计划」「数字阅读协作」两篇 Word 文档，各 6 句、每句 3 人，可用于后续体验。现有三篇文章的每句 8 人配置已在调额测试后恢复。

验收记录：`test-results/article-management-20261008.json`；画面：`test-results/article-management-desktop.png`、`test-results/article-management-config.png`、`test-results/article-management-mobile.png`。本机专用镜像与正式发布镜像统一使用 0.2.2。

## 翻译审核与重译验收

2026-10-08 本环境已更新按志愿者分组的审核工作台，支持姓名/账号搜索、文章和状态筛选、同句候选对比。退回必须填写修改意见；志愿者可在「我的数据与审核结果」中查看采纳、退回和未采纳状态，并从原任务修改重提。两端均可展开修订与审核记录。

审核和重提携带版本号，过期操作返回 409。第一版兼容旧客户端；重提已有译文和审核第二版及以后的译文必须带版本。采纳后同句全部任务结束，其他译文为未采纳，不能再次提交。重提不会重复增加任务、占用新的名额或增加独立译文计数。

升级前的原始备份为 `deploy/backups/simulation-before-review-workflow-20261008.sqlite`。另存了包含浏览器验收账号的升级前备份 `deploy/backups/simulation-review-with-browser-fixture-20261008.sqlite`。对原始备份副本已验证增量迁移、内容和时间保留、重复启动幂等以及数据库完整性。首次启动自动增加审核意见、版本号和历史表，无需清空数据。

已通过后端冒烟、文章配置、10 人并发、模型异常回归、完整审核专项及前端 18 项 API 回归。重新构建的 Linux 后端镜像在禁用外网、只读根文件系统下通过审核专项，随后更新后端/前端/Nginx 并完成双会话浏览器验收：全部提交 → 退回并自动同步 → 同任务 V2 重提 → 采纳并自动同步 → 查阅 V1 退回意见。手机端按 390 × 844 验证，没有横向溢出。

浏览器保留了账号「译者0400」，有 1 条已采纳记录和 1 条可修改重提的退回任务。这位旧验收账号保存在 `127.0.0.1:18082` 的浏览器会话中；新版推荐两端统一使用 `localhost:18082`，同源下已使用独立角色会话，无需通过不同主机名隔离。在志愿者端点击「我的数据与审核结果」查看。重新进入翻译入口只恢复已登录账号，不自动领取新任务；后台分配或志愿者主动领取后，任务写入共享数据库。

本轮验收记录：`test-results/review-workflow-20261008.json`、`test-results/review-migration-20261008.json`。Docker 构建与专项日志分别为 `review-build-20261008.log`、`review-container-20261008.log`；页面画面为 `review-volunteer-admin.png`、`review-results-mobile.png`。本次仅更新本机测试镜像，正式仓库镜像与离线交付包尚未包含这次功能升级。


## 注册、定向分配与双端数据库同步验收

2026-10-08 已更新本机环境。两端统一使用 `http://localhost:18082/simulation/`，在同一浏览器可同时保持管理员与志愿者登录。志愿者必须主动注册，入口不会暗中创建账号或分配任务。当前宽松注册允许任意或空白资料，不接第三方实名接口，开通结果及核验来源写入数据库；手机号、身份证号和银行卡号仍加密存储。

后台操作路径：管理工作台 → 文章管理 → 管理文章 → 分配给志愿者 → 选择志愿者。可按姓名或账号筛选已注册人员（包括尚未提交任何译文的人），每次为每人分配 1 或 2 句。分配遵守每句协作人数上限，不重复分配同一人同一句，已采纳句子不再分配；名额不足时展示每位志愿者的实际结果。

两端每 5 秒同步数据库接口；页面返回前台、窗口获得焦点或网络恢复时立即更新。未分配任务或所有任务已结束时也会继续检查。管理员登录不再覆盖志愿者身份，切换工作台不会生成另一个账号；新译文、退回意见、重提版本和采纳结果都可自动到达另一端。正在填写的草稿、比例和退回意见会保留；审核页收到新版本时需先查看最新译文，避免误审旧版本。

真实浏览器验收：注册「同步注册1008」，使用任意格式资料并成功入库；保持后台分配列表打开，新账号自动出现；后台分配「社区共译计划」两句后，原先空白的志愿者任务页面自动收到任务；完成提交 → 后台自动出现 → 退回 → 志愿者自动收到意见 → V2 重提 → 后台提示新版本 → 采纳 → 志愿者自动收到采纳结果。整个过程使用同一 `localhost:18082` 地址，无需刷新同步。

随后强制重建后端、前端及 Nginx 容器，逐项核对这位志愿者的资料、任务、译文和两个历史版本，重建前后完全一致；浏览器重新载入后恢复同一账号与任务。业务数据库为 `/app/data/translation.sqlite`，持久卷为 `translation-platform-simulation_translation_data`（业务数据当前不在 PostgreSQL）。重建后共 11 位注册用户、5 篇文章、22 个任务、18 份独立译文，数据库完整性检查为 `ok`。未删除已有记录。

本次已通过前端 32 项测试、入口 5 项测试、后端会话隔离和注册分配专项（含 10 人并发）。两项后端专项还在实际 Linux 镜像、禁用外网和只读根文件系统下通过。手机端 390 × 844 检查无横向溢出。OpenAI 兼容配置沿用真实 `plmf/glm-5.3-flash`，本轮测试使用已有预译内容。

升级前备份：`deploy/backups/simulation-before-shared-sync-20261008.sqlite`。验收汇总：`test-results/shared-sync-20261008.json`；数据库重建前后对照：`test-results/shared-sync-db-before-restart-20261008.json`、`test-results/shared-sync-db-after-restart-20261008.json`；画面：`test-results/shared-sync-admin.png`、`test-results/shared-sync-mobile.png`。

本轮仅更新本机三个测试镜像和运行服务；正式镜像仓库与离线交付包尚未包含这次更新。


## 0.2.2 正式镜像发布

2026-10-10 本轮功能已构建进独立的正式 0.2.2 镜像并发布到腾讯云 TCR。正式版本包含注册配置、文章管理、按句/段落/章节分派、按志愿者审核、双端同步及主备模型通道；本机专用镜像中的快捷入口、测试资料和模型网络适配未带入正式镜像。本机 18082 服务与既有数据继续保留。最新交付和离线操作见 `deploy/README.md`。
