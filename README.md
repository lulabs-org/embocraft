# Agent Voxel World

独立的本地多人 3D 体素原型：TypeScript · pnpm workspace · React/Vite · Three.js · Node/Colyseus · PostgreSQL/Prisma。

## 快速运行

环境要求：Node 22.13+、pnpm 10、PostgreSQL 17 二进制。macOS 默认使用 `/opt/homebrew/opt/postgresql@17/bin`，其他路径通过 `PG_BIN` 指定。无需 Docker 或云账号。

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:start
pnpm db:migrate
pnpm dev
# 另一个终端（运行 AI 玩家或测试机器人）：
pnpm agent:ai    # 或运行无 AI 的测试机器人：pnpm agent:mock
```

打开 http://127.0.0.1:5173 ，用两个独立浏览器上下文输入不同昵称进入。服务只绑定 `127.0.0.1:2567`。`pnpm db:start` 只在本项目 `.data/postgres` 初始化数据库，在端口 55432 启动，创建被 Git 忽略的 `.env`，绝不覆盖已有 `.env`。端口被占用或数据目录没有项目标记时拒绝启动。开发用凭据仅适用于本地测试。

停止前端/服务端用 Ctrl+C；停止独立数据库用 `pnpm db:stop`。再次 `pnpm db:start` 使用原数据。不要删除 `.data`，除非有意丢弃这个原型的世界。

如果没有 `DATABASE_URL`，服务器明确进入 `memory` 模式：刷新页面仍读取活跃房间，但服务重启会丢失编辑。配置了数据库但连接失败时，启动失败，绝不悄悄切成内存模式。

`pnpm dev` 不会自动启动数据库。后端会在监听端口前检查数据库连接及世界表，失败时显示中文原因和处理命令，不再输出重复的 Prisma 启动堆栈。若提示无法连接 `127.0.0.1:55432`，请手动运行 `pnpm db:start`，然后重启 `pnpm dev`；若提示表结构未准备好，请先确认数据库配置再运行 `pnpm db:migrate`。Vite 显示 `ready` 只表示前端就绪，后端启动失败时仍无法进入世界。未配置数据库时会明确警告内存模式不保留重启后的编辑。

## Docker 容器化部署

本项目支持使用 Docker Compose 进行一键全栈容器化部署，包含 PostgreSQL 17 数据库、Node 后端服务（自动执行迁移并启动 Colyseus/Express）以及 Web 前端（Nginx 静态托管与统一反向代理）。

### 1. 一键启动

```sh
# 使用 pnpm 快捷脚本
pnpm docker:up

# 或直接使用 Docker Compose 原生命令
docker compose up -d --build
```

默认不要求本地模型，克隆后可直接构建。需要离线语音识别（SenseVoice）时，先下载模型包再构建，server 镜像会把它打包进去：

```sh
pnpm voice:sensevoice   # 从 k2-fsa 发布页下载约 150 MiB 模型包并解压到 models/
pnpm docker:up          # 或 docker compose up -d --build
```

`models/` 只提交 `.gitkeep` 空目录，模型包不入库；未下载模型时镜像照常构建并打印跳过提示，识别自动回退 Speaches Whisper（首次识别联网下载模型）。

启动完成后：

- **Web 前端**：打开浏览器访问 `http://localhost`（默认 80 端口，前端通过 Nginx 自动反代 API 与 WebSocket）
- **Swagger API 文档**：访问 `http://localhost:2567/api-docs`
- **数据库**：PostgreSQL 数据自动持久化在 `voxel_postgres_data` 数据卷中，宿主机端口 `55432`
- **语音服务 ASR / TTS**：内置共享 `voxel-speech`（Speaches，Compose 服务名 `speech`）容器，CPU 使用 int8 推理，模型缓存在 `voxel_whisper_cache` 卷中。Whisper 首次识别需要联网下载模型，下载后可离线识别；模型加载后常驻内存，避免空闲后重复冷启动。服务器也可选用本地 SenseVoice（sherpa-onnx）：先运行 `pnpm voice:sensevoice` 下载模型包，server 镜像构建时会把 `models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/` 打包进镜像，无需再挂载；未下载模型时镜像照常构建，识别回退 Whisper。详见 [语音配置](docs/VOICE.md)。
- **Piper TTS**：控制台选择中文 Huayan / 超文 Chaowen 或英文 Lessac，点击“安装模型”，安装后可离线合成。旧 macOS 服务自动迁移，保留 Agent 绑定；原配置备份为 `voice-services.json.pre-piper.bak`。
- **服务配置**：模型、ASR 与 TTS 配置保存在 `voxel_server_data` 卷中，重建容器会保留。旧部署升级前，请先备份旧容器的 `/app/.data` 并迁入该卷。

录音需要允许浏览器和系统的麦克风权限。通过本机 `http://localhost` 或 HTTPS 访问；局域网 HTTP 地址无法使用麦克风。若内置浏览器一直等待授权，可在 Chrome / Edge 打开同一地址，或使用“用音频文件测试”。连续录音未识别到讲话时会继续监听；首次模型加载可能较慢，整句识别最多等待约 100 秒。

从旧版本升级时，先停止并移除旧语音容器，再启动新服务（不要删除数据卷）：

```sh
docker stop voxel-whisper
docker rm voxel-whisper
docker compose up -d --build
```

新服务保留网络别名 `whisper`，继续使用 `voxel_whisper_cache` 卷。统一地址由 `SPEECH_API_URL` 配置；ASR 可用 `WHISPER_API_URL` 覆盖，Piper 可用 `PIPER_API_URL` 覆盖。Piper 未设置统一地址时兼容旧 `WHISPER_API_URL`。`SPEECH_PORT` 优先于旧 `WHISPER_PORT`，默认 `8000`。

### 2. 常用管理命令

```sh
# 查看运行日志（含迁移与启动状态）
pnpm docker:logs
# 或：docker compose logs -f

# 停止并移除容器
pnpm docker:down
# 或：docker compose down

# 停止并清理所有数据卷（清空世界、服务配置和语音模型缓存）
docker compose down -v
```

### 3. 自定义配置（可选）

如需修改端口或注入模型 API Key，可参考 `.env.docker.example` 创建或在环境中设置：

- `WEB_PORT`：前端访问端口（默认 80）
- `DEEPSEEK_API_KEY`：DeepSeek Agent API 密钥
- `WEB_ORIGIN`：跨域 Origin 允许列表（默认为 `*` 允许所有网络地址访问）

## 操作

- 点击画面锁定鼠标；WASD 移动、Space 跳跃、鼠标转向，Esc 释放。
- 中央准星选择 6 格以内的方块；左键移除、右键放置。也可使用底部 Remove / Place block 按钮；点击材质卡选择方块。
- 地形碰撞、重力、速度、编辑距离、基岩保护、玩家占用、相邻支撑和版本冲突均由服务器校验。
- 聊天支持群聊、@ 私聊、语音转文字和语音消息；附近语音可独立开启麦克风与收听，按距离和朝向调节音量，并自动分段转写给附近玩家与 Agent。详见 [聊天与空间语音](docs/CHAT.md)。开启 Agent 的语音回复后，附近已开启收听的玩家可听到它的声音，私聊只对指定对象播放。玩家位置以 20Hz 权威更新，画面进行插值。
- 页面刷新自动使用当前标签页的昵称和重连令牌；异常断线 20 秒内可保留身份，超时或服务器重启则重新入房。
- 控制台的“文本转语音（TTS）”管理本机、百炼及兼容接口的音色，支持保存、试听和 Agent 绑定。“语音识别（ASR）”支持自托管 Whisper、本地 SenseVoice、阿里云百炼实时识别与 OpenAI 兼容接口（远程），可配置模型、语言、地域与服务端密钥，试用临时字幕及逐句确认；聊天与附近语音默认优先使用已安装的本地 SenseVoice，否则回退 Whisper。详见 [语音配置](docs/VOICE.md)。

## 验证

```sh
pnpm check             # 全仓 ESLint、类型、单元及 DOM 回归测试、所有应用构建
pnpm lint              # 检查应用、共享包、脚本、测试和配置文件
pnpm lint:fix          # 自动修复可修复的全仓 lint 问题
pnpm test:integration  # 随机端口、临时存档中的世界协议集成测试
pnpm format:check
```

ESLint 由根目录 `eslint.config.js` 统一配置，`apps/server`、`apps/web`、`packages/agent-runtime` 和 `packages/shared` 也可通过 `pnpm --filter <包名> lint` 单独检查。TypeScript 使用推荐规则和 Promise 检查；前端增加 Hooks 调用顺序与依赖检查，Node、浏览器和 AudioWorklet 分别配置环境。生成目录、依赖、运行数据和测试产物不参与 lint；格式由 Prettier 负责。

集成测试在随机端口和临时存档中启动两个 SDK 玩家和一个脚本 Agent，检查并发编辑仅一方成功、三方同步、非法动作拒绝、聊天、断线恢复、持久化模式及 mock 字幕打断。真实双浏览器和服务重启记录见 [验证记录](docs/VALIDATION.md)。测试只修改临时测试世界，结束后清理。

## 结构

- `apps/web`：按 feature 拆分的 React UI、Three.js 实例化体素、插值、重连。目录、依赖边界及浏览器验收见 [Web 架构](apps/web/README.md)。
- `apps/server`：Colyseus 单一权威世界、事务存储、语音 provider 接口。
- `apps/server/prisma`：PostgreSQL schema 和可重放迁移。
- `scripts/agent`：脚本测试机器人（Scout）、独立 AI 玩家与管理命令行入口，保留所有 `pnpm agent:*` 命令。
- `packages/shared` 的管理子入口：Web/CLI 共用 HTTP 管理接口和 WebSocket 状态通知；托管核心在服务端领域模块中。详见 [Agent 管理接口](docs/AGENT_GATEWAY.md)。
- `packages/agent-runtime`：CLI 与服务端共用的会话客户端、动作、模型规划和任务运行时，通过 `@voxel/agent-runtime` 引用。
- AI 玩家：配置 `DEEPSEEK_API_KEY` 或 `AGENT_API_KEY` 后运行 `pnpm agent:ai`，支持观察、移动、聊天和显式开启的方块编辑。使用 Pi 模型适配与工具循环，支持思考模式；启动端口与配置见 [Agent 接入](docs/AGENT_PLAYERS.md)。
- `packages/shared`：协议、确定性地形、物理与校验。

服务端按领域组织，HTTP 装配与网络生命周期分离，生产和集成测试共用服务器工厂。详细边界见 [服务端架构](apps/server/README.md)。

```text
apps/server/
├── prisma/                 # schema 与 migrations
├── src/
│   ├── index.ts            # 环境加载、监听与信号处理
│   ├── app.ts              # createApp：HTTP 路由装配
│   ├── server.ts           # createServer：依赖、房间与连接生命周期
│   ├── config/             # 环境配置、校验与稳定的数据路径
│   ├── common/             # 通用错误、校验、命令队列与 Origin 判断
│   ├── http/               # HTTP 装配、中间件、管理策略、健康检查与文档路由
│   ├── openapi/            # OpenAPI schema 与 Swagger 扫描
│   ├── transport/          # Socket 路由类型与 Gateway / ASR / Colyseus 分发
│   ├── persistence/        # 角色与任务联合存档、迁移和提交
│   └── modules/
│       ├── ai-characters/  # 角色生命周期、唤醒、执行与配置
│       ├── providers/      # 模型提供商配置与模型目录
│       ├── tasks/          # 任务计划、调度、执行控制与历史
│       ├── management/     # 管理命令回执、错误与事件
│       ├── gateway/        # 管理令牌与 WebSocket 通知
│       ├── audio/          # asr、tts、session 与音频路由
│       ├── chat/           # 聊天、附件、票据与 HTTP 路由
│       ├── realtime/       # 实时会话、百炼适配器与离线协议模拟器
│       └── world/          # 权威房间、Schema、存储与世界路由
└── test/
    ├── helpers/            # createTestServer：隔离状态的生产装配
    ├── integration/        # 独立临时世界中的集成脚本
    └── sandbox/            # 独立沙盒启动入口
```

`pnpm test:voice:services`、`pnpm test:agents`、`pnpm test:chat`、`pnpm test:agent:voice`、`pnpm test:agent:tasks` 和 `pnpm test:agent:deepseek` 指向服务端集成脚本，使用隔离世界和固定模型响应。实时会话集成与沙盒命令见 [百炼实时语音](docs/ALIYUN_REALTIME.md)。这些脚本由 `tsx` 显式运行，不进入默认 Vitest 扫描；根目录 `pnpm test:integration` 也在独立临时世界中运行。

`pnpm --filter @voxel/server test` 运行服务端就近测试。`pnpm test:navigation:live` 需要显式提供模型配置，会产生真实模型调用；启动方式与验收范围见 [验证记录](docs/VALIDATION.md)。

前端按功能与基础设施组织：

```text
apps/web/src/
├── main.tsx                # React 挂载与单个世界连接的热更新清理
├── App.tsx                 # 大厅、游戏场景与面板装配
├── features/
│   ├── console/            # 控制台、表单、任务卡片、状态控制器与 API
│   ├── chat/               # 消息、选人、录音草稿、状态控制器与 API
│   ├── voice/              # 语音面板、能力查询与实时语音样式
│   └── world/              # 在线玩家面板
├── graphics/               # Three.js 场景、角色与名称牌
├── audio/                  # 采集、播放、转写及 PCM Worklet
├── network/                # 服务地址、连接与在线状态订阅
└── styles/                 # 全局样式
```

功能的 HTTP 请求由对应 `api.ts` 管理；通用 HTTP/WebSocket 地址统一从 `network/endpoints.ts` 解析。音频基础设施保留自身的流处理与请求取消。组件不从录音模块获取服务地址，也不直接发起 HTTP 请求。单元测试可以就近维护，已有跨模块回归测试仍保留在根目录 `tests/`。

控制台状态由 `useConsoleController` 持有，表单和任务卡片通过参数与回调交互；语音面板在切换分类或关闭控制台时保持挂载。`useChatController` 管理选人、录音与发送状态，并在断线或卸载时清理采集与上传。`pcm-worklet.js` 与加载它的 `realtime-audio.ts` 同目录。开发、独立预览与根目录测试继续使用相对导入，不要求路径别名。

`output/`、`dist/` 和 `node_modules/` 不参与源码类型检查；历史临时验收文件不属于正式源码。

## 范围和限制

这是本地单进程、单世界、最多 16 会话的原型，不是完整 Minecraft。地形 25×25、高度上限 15；没有背包、合成、战斗、账户鉴权、反作弊运营、多人分片或生产部署。方块编辑持久化，玩家位置、聊天、事件和语音会话暂不持久化。事件环形缓存保留最近 100 条，观察返回最近 30 条当前会话有权接收的事件。

Agent 观察是以自身为中心半径 8 的距离裁剪，最多 500 个最近方块，不做遮挡/视锥裁剪；这是结构化场景接口，并非模型视觉。Agent 与人类共用同一移动和编辑校验。Scout 脚本 Agent 没有 LLM；DeepSeek AI 玩家由模型决策，两者都没有额外管理权限。协议见 [接口文档](docs/PROTOCOL.md)。

语音方案已支持 `mock`、`browser` 和 `ollama`。回声不是 AI；Ollama 需预先安装并配置。聊天语音识别由服务器处理：默认 `ASR_PROVIDER=auto` 时优先使用已安装的本地 SenseVoice，否则回退 Whisper；控制台另支持阿里云百炼实时 ASR 试用和云端 TTS。云端凭据仅保存在服务端，不能放 `VITE_*`。

### 在大厅创建 AI 玩家

首次打开控制台先输入管理员令牌（可用 `pnpm agent:ctl auth show` 读取本地令牌文件），再点击 **模型服务** 配置接口，再到 **Agent 玩家 → 创建 Agent** 设置昵称、模型与能力。默认创建后加入世界待命，也可选择立即执行任务。角色工作区将任务、角色设置和运行记录分开；离开世界保留设置和进度，再次加入待命不会自动重跑旧任务。已有 DeepSeek 环境变量会在首次启动管理服务时导入。Agent 先由独立对话循环回复或接受任务，再由任务循环通过 Pi 顺序调用世界工具，一次唤醒可在预算内持续多轮推理，逐步观察，失败停止后续工具；按任务进展自主继续或停止，普通消息在动作边界插入，空闲不调用模型。支持固定/随机轮询、任务暂停/继续/取消、进度与 token 用量，以及高级预算保护。详见 [AI 玩家接入](docs/AGENT_PLAYERS.md)。

## 开源协议

本项目基于 [MIT](LICENSE) 协议开源。
