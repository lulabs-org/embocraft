# 服务端架构

`index.ts` 是唯一自动加载仓库 `.env` 的入口，负责启动与 SIGINT/SIGTERM 处理。导入 `app.ts` 或 `server.ts` 不会监听端口或加载 `.env`。

## 装配与生命周期

- `createApp` 接收按用途分组的 HTTP 依赖（health、management、asr、tts、world、chat），仅装配 Express 中间件及路由，不创建数据库连接或网络监听器。世界房间 ID、presence 和聊天能力通过延迟访问函数注入。
- `createServer` 检查数据库配置、加载本地服务配置并装配 Agent、世界、HTTP 和 WebSocket。`listen()` 绑定端口、创建世界，然后恢复 Agent；端口为 0 时，内部 Agent 连接使用实际分配的端口。
- `close()` 可重复调用。先关闭 Agent 与 Colyseus 房间，再终止 ASR WebSocket、HTTP/SSE 连接并释放存储；启动失败也走同一清理路径。
- 仍为单进程单世界模型。Colyseus 的 matchMaker 与房间占用状态属于进程；不要在同一进程同时创建多个服务器。测试中的多个世界应顺序关闭后再创建，或放在独立进程中。
- PostgreSQL 启动与迁移继续由开发者显式执行。配置了数据库但不可用时给出诊断和恢复命令，不自动启动数据库；生产启动未配置 `DATABASE_URL` 时会报错。测试可注入存储与归档依赖使用内存世界。
- 数据库客户端与 Pg 连接池统一由 `core/database/client.ts` 创建。`core/database/health.ts` 使用独立短连接完成启动探活并释放；`createServer` 创建一个运行时客户端，供默认的 World、Provider、联合存档及 TTS/ASR 存储共享，待 Agent、房间和网络连接关闭后统一断开，不使用进程级单例。
- `WorldStore(url)` 保留独立创建和关闭客户端的行为，`WorldStore('')` 保留内存模式；通过第二个参数注入客户端时只借用连接，`close()` 不断开它，由注入方负责释放。`ServerOptions.worldStore` 等测试注入接口保持不变。

## 依赖方向

`core` 不引用业务领域或全局持久化层；`modules` 不反向引用 `app.ts`、`server.ts`、入口、传输实现或顶层 HTTP 装配。管理 HTTP 管线与请求策略归入 `modules/management/routes/`，业务路由通过 management 门面复用该策略。management 的 HTTP 层不导入其他业务模块，由 `app.ts` 注入路由安装回调与命令指纹的请求体规整函数，避免模块循环依赖。`core/transport/socket-routes.ts` 只定义 Socket 路由类型；模块的 Socket 适配文件可通过 `import type` 使用该契约，不得引用 `websocket.transport.ts`。装配入口和业务模块跨域引用统一经过各模块根部的 `index.ts`。

| 目录                    | 责任                                                 |
| ----------------------- | ---------------------------------------------------- |
| `core/config`           | 类型化配置、部署变量校验、`.env` 加载与数据路径      |
| `core/database`         | 数据库客户端与连接池创建、启动探活和异常脱敏         |
| `core/errors`           | 通用 `AppError`                                      |
| `core/concurrency`      | 命令队列                                             |
| `core/http`             | HTTP 中间件、输入校验、Origin 判断与 health 路由     |
| `core/openapi`          | OpenAPI schema、Swagger 文档生成与 docs 路由         |
| `core/transport`        | Socket 路由类型、Gateway/ASR/Colyseus 路径分发和关闭 |
| `core/audio`            | PCM 校验、FFmpeg 规整、Speaches 端点与模型发现       |
| `persistence`           | 角色与任务联合存档、迁移、提交及失败处理             |
| `modules/management`    | 管理 HTTP 管线、指令路由、幂等回执与状态变更事件     |
| `modules/ai-characters` | 生产依赖注入、Agent 生命周期编排与配置文件适配       |
| `modules/providers`     | 模型提供商持久化存储与模型列表服务                   |
| `modules/tasks`         | 任务计划、运行历史与执行控制领域服务                 |
| `modules/gateway`       | 管理令牌与 WebSocket 状态通知                        |
| `modules/asr`           | ASR 配置存储、Whisper/百炼识别、调度、转写与能力路由 |
| `modules/tts`           | 音色服务存储、Piper/远程合成、模型状态与管理路由     |
| `modules/chat`          | 消息、附件、音频票据及私聊权限                       |
| `modules/world`         | 权威物理房间、Schema、持久化、SSE、Agent 语音与信令  |

`asr/services/local-speech.service.ts` 负责通过独立语音服务 API 进行 Whisper 识别。Piper 模型和声音服务的管理路由归 `tts`，HTTP 地址为 `/voice/tts/services`；Agent 音色绑定由 Agent 管理器处理，删除服务通过注入回调检查绑定，音频模块不反向依赖 Agent。`character.manager.ts`、`orchestrator.service.ts` 位于 `ai-characters/services/`，Provider 仓储契约与数据库实现归属 `providers/persistence/`，`tasks` 模块按 `domain/`、`services/`、`persistence/` 和 `routes/` 分层；`ports.ts` 集中声明管理接口、执行状态与宿主契约。角色与任务的联合存档由 `src/persistence` 负责：先串行保存，再更新已提交视图，最后调用注入的提交通知回调；角色编排器将该回调连接到 `ManagementEvents.commit()`。存储失败时保留现有执行保护。角色和任务快照的捕获、恢复仍由各模块的 `persistence/` 实现，通过注入契约参与提交。

全局 `persistence/` 直接提供存档契约、数据库驱动、结构规整和提交协调器，不再由 management 门面重导出。该层仅依赖自身及 `core/errors`、`core/database`。它不依赖角色运行时、任务模块、管理事件实现或 HTTP 装配；management 与 tasks 不反向依赖全局持久化层。`storageRevision` 只在保存失败时递增，`flush(since)` 只等待已排队的保存并检查失败代次，不捕获新快照。

业务错误与通用异常统一使用 `core/errors/app-error.ts` 中的 `AppError`。复用 Origin 判断和异常处理机制不意味着统一所有端点的策略：保留语音接口允许无 Origin、管理接口的 Origin 校验、原有预检方法、JSON/原始音频限制以及错误状态和文案。Swagger 扫描 `core/http`、`core/openapi` 和 `modules` 下的 `*.routes.ts`，以及 `modules` 下的 `routes.ts`。

Agent 托管集合、唤醒调度、生命周期操作和日志位于 `modules/ai-characters`，任务计划、执行控制与计划调度位于 `modules/tasks`，模型提供商归入 `modules/providers`。各模块高内聚低耦合，不再依赖外部编排包。HTTP 路由和 OpenAPI 注释由各领域维护，`app.ts` 显式装配依赖；Provider 路由仅接收存储、模型查询、删除和变更通知接口。`modules/management/routes/management.http.ts` 通过门面导出的 `installManagementHttp` 装配鉴权、32 KiB JSON、404 和错误映射，并创建一个共享的 `ManagementCommands` 实例。`app.ts` 注入角色、模型提供商和任务路由的安装回调；management 随后安装命令回执查询。共享请求策略位于同目录的 `management-policy.ts`，回执路由及 OpenAPI 注解位于 `managements.routes.ts`；顶层 `src/http/` 已移除。TTS 复用同一请求策略，但不进入命令回执队列；ASR 配置保留 8 KiB JSON 和专用错误映射，转录保留原始音频请求体。路由直接注册在 Express app 上，保留命令指纹使用的完整 `req.path`。

`management/services/` 集中 `command-router.service.ts`、`commands.service.ts` 与 `events.service.ts`，错误映射辅助函数位于 `public-error.ts`，命令服务测试与源码共置。`CommandRouter` 为 `core/concurrency/command-queue.ts` 的通用队列提供管理错误策略，`ManagementCommands` 负责 HTTP 命令标识与指纹输入，`ManagementEvents` 计算快照差异并通知订阅者。公共回执与错误契约继续由 `@voxel/shared/management` 提供；模块不重复定义回执模型。根部 `index.ts` 保留全部公开导出，幂等指纹、排队顺序、回执状态、错误映射及事件通知行为保持不变。

`ai-characters/services/` 集中角色管理器、编排器、宿主、唤醒调度与语音协调；服务使用 `*.service.ts` 命名，生产装配包装器为 `character.manager.ts`。`job.ts`、`execution-context.ts`、`task-adapter.ts` 与 `world-event-handler.ts` 是同层运行时辅助文件，保留会话、Runner 与任务状态适配职责。HTTP 路由和 OpenAPI 注解位于 `routes/ai-characters.routes.ts`，纯校验与日志留在 `domain/`，角色快照留在 `persistence/`。模块根部 `index.ts` 保留全部公开导出；目录调整不改变角色生命周期、唤醒时序、语音行为、接口或存档格式。

`gateway` 保持轻量目录：`auth.service.ts` 负责令牌加载与 HTTP 鉴权，`gateway.socket.ts` 负责管理通知握手、事件订阅与连接清理，`validation.ts` 校验握手数据。根部 `index.ts` 保留全部公开导出，令牌读取顺序、Origin 策略、通知协议和关闭行为保持不变。跨管理模块与共享客户端的 `test/gateway.test.ts` 保留在集成测试目录，并通过 gateway 门面引用。

`providers` 保留现有 `domain/`、`adapters/`、`persistence/`、`services/` 和 `routes/` 分层。服务与就近测试统一命名为 `services/provider.service.ts` 和 `provider.service.test.ts`；模块门面继续导出 `ProviderService`，提供商读写、删除引用检查、模型查询、健康检测及变更事件行为保持不变。

`ModelCatalog` 由 `createServer` 创建并直接注入 Provider 路由，角色编排器不再持有它。`agentDependencies` 仅配置角色的 session 与 runner。删除模型或音色服务仍经角色管理器检查关联约束。

Agent 共用运行时继续位于 `packages/agent-runtime`，不迁入服务端。每个 Job 持有一个 `AgentRuntime`，服务端通过其消息、执行、控制、查询和恢复方法操作角色；CLI 使用同一门面的 `runUntilSettled()`。宿主不再自行解析控制词、拼接事件标识或读写运行时分区；任务账本、连接、定时器和联合存档事务仍由服务端管理。已删除 `Job.memory/attention` 别名；运行时存档使用 version 4 的角色/执行双分区，旧运行时存档会明确报错，不自动迁移。

`chat` 按 `domain/`、`services/` 与 `routes/` 分层：`domain/visibility.ts` 按消息范围、发送者与接收者判断可见性；`services/` 集中聊天、凭据、音频缓存、空间语音票据及 ASR 协调，统一使用 `*.service.ts` 命名；`routes/chats.routes.ts` 保留 `/chat` 的 HTTP 接口与 OpenAPI 注解。路由和语音协调测试与源码共置，跨包的 `test/chat.test.ts` 保留在集成测试目录。模块门面继续导出 `WorldChat`、`installChatRoutes` 与 `visibleEvent`，聊天鉴权、可见性、语音处理和票据生命周期保持不变。

`world` 的地形、玩家名称和输入/编辑校验规则归入 `domain/`，数据库存储与就近测试归入 `persistence/`，HTTP/SSE 路由与测试归入 `routes/worlds.routes.ts` 及同名测试文件。`world.room.ts` 与 `world.schema.ts` 留在模块根部，分别负责 Colyseus 房间生命周期与同步状态 Schema；Schema 依赖框架，不属于纯领域规则。模块门面保留 `WorldRoom`、`WorldStore`、`installWorldRoutes` 和 `installPresenceRoutes` 四个公开导出。Schema 字段与注册顺序、物理模拟、持久化、房间生命周期及 `/world`、`/world/presence` 行为保持不变。跨共享物理实现的世界规则测试与服务器生命周期测试保留在 `test/`。

音频能力按职责拆为 `core/audio`、`modules/asr`、`modules/tts` 三部分，空间语音与 Agent 发声归入 `modules/world`：

- `core/audio/` 只放无业务状态的共享基础设施：`pcm-wav.ts`（无 I/O 的 PCM WAV 格式、时长与音量校验）、`normalize.ts`/`command.ts`（FFmpeg、子进程与临时文件处理）、`speech-endpoint.ts`（部署默认的语音服务地址）、`speaches-models.ts`（Speaches 模型与音色发现）以及 `voice-service-connection.ts`（ASR/TTS 共用的连接参数校验）。该目录只依赖 `core`。
- `modules/asr/` 按 `persistence/`、`services/`、`routes/`、`sockets/` 分层。`routes/asr.http.ts` 的 `installAsrHttp` 保留 ASR 管理鉴权与 `capabilities → transcribe → asr` 的安装顺序；`sockets/asr.socket.ts` 注册 `/voice/asr/realtime`。门面导出 `installAsrHttp`、`AsrSettingsStore`、`DatabaseAsrServicePersistence`、`installAsrSocket`、`AsrBridge`、`LocalSpeech` 与 `scheduleSpeech`。`/voice/capabilities` 同时报告 Whisper 与 Piper 状态，经 `tts` 门面读取 `PiperModels`。
- `modules/tts/` 按 `persistence/`、`services/`、`routes/` 分层，合成契约位于 `services/speech-synthesizer.ts`。`routes/tts.http.ts` 的 `installTtsHttp` 通过 management 管线注册 `/voice/tts`。门面导出 `installTtsHttp`、`VoiceServiceStore`、`DatabaseVoiceServicePersistence`、`PiperTts`、`PiperModels` 与 `SpeechSynthesizer`。`tts` 不依赖 `asr`、`chat` 或 `world`。
- 两个 Store 仍包含原有校验与运行时协调职责，显式接收持久化适配器；生产使用 PostgreSQL，测试使用内存实现。默认数据、串行写入、数据库事务、识别占用、音色绑定及删除保护行为保持不变。

`AgentSpeech` 位于 `modules/world/services/agent-speech.service.ts`，负责语音合成队列、空间听众筛选和音频缓存访问。`WorldRoom` 装配它，在聊天消息送达后入队，在关闭语音、离线、音色服务变更或房间销毁时取消或清理。聊天路由只依赖本地声明的 `AgentSpeechClips` 读取契约，由 `server.ts` 注入 `world.agentSpeech`，避免 `chat → world` 的循环依赖。空间信令由 `modules/world/services/spatial-signaling.service.ts` 提供，通过 `WorldRoom` 消息转发，没有独立 Socket 端点。Agent 核心调度不依赖这些服务。

## 结构验收

本轮目录与命名整理已完成。架构测试位于 `tests/server-boundaries.test.ts`，检查跨模块门面、依赖方向、Socket 契约、循环依赖及再导出形成的间接 HTTP 依赖。`core/openapi/swagger.test.ts` 扫描全部服务端非测试 TypeScript 文件中的显式 `app.get/post/put/patch/delete` 注册；动态路径、Router 别名和 `app.use` 不在当前覆盖范围。测试反例验证再导出和非路由文件中的新增路由不能绕过已有检查。ASR/TTS Store 的校验、运行时协调和持久化职责保持现状，进一步拆分需单独评估。

## 状态与测试

`dataPath()` 锚定仓库根目录，Docker 中对应 `/app/.data/`。生产默认将模型提供商、Agent/任务联合存档和 TTS/ASR 配置保存在 PostgreSQL；旧 JSON 存储后备路径已移除，网关令牌及本地语音模型文件保留原配置位置。现有数据库存档恢复与运行时迁移继续保留。

`test/helpers/test-server.ts` 使用生产 `createServer`，通过 `test/helpers/memory-storage.ts` 注入内存模型服务、角色存档与语音配置；默认配置临时令牌目录、内存世界、随机 loopback 端口与 mock 语音。调用方可注入模型运行器、存储和语音依赖；`close()` 清理工厂拥有的临时目录，调用方提供的目录由调用方负责。默认 fixture key 不可用于真实推理。

```sh
pnpm --filter @voxel/server test  # 服务端就近测试与网络生命周期
pnpm --filter @voxel/server lint  # 服务端源码、测试和配置的 ESLint 检查
pnpm check                       # 全仓 lint、类型、单元测试和构建
pnpm test:agents
pnpm test:agent:tasks
pnpm test:navigation
pnpm test:chat
pnpm test:voice:live
pnpm test:agent:voice
pnpm test:voice:services
pnpm test:agent:deepseek
pnpm test:player:names
```

`pnpm lint` / `pnpm lint:fix` 在根目录检查全仓。服务端单独运行 `pnpm --filter @voxel/server lint` 或 `lint:fix`，沿用根目录配置，覆盖源码、测试（含集成脚本与沙箱）及 Prisma 配置。启用 ESLint/TypeScript 推荐规则、未处理 Promise 和异步回调误用检查，零警告才通过。生成目录和依赖不参与检查，格式由 Prettier 负责。

以上推理/语音集成默认使用固定响应，仍通过真实 HTTP、WebSocket 与物理执行。真实模型导航需显式运行 `NAVIGATION_PROVIDERS=/absolute/path/providers.json pnpm test:navigation:live`；测试不会自动读取生产凭据，也不修改当前开发世界。结果默认写入 `artifacts/navigation-live-model.json`。

`tests/server-boundaries.test.ts` 检查依赖方向、全局持久化边界、循环依赖、配置入口和集成装配，并限定业务模块仅从 Socket 适配文件以 `import type` 引用传输契约。Prisma 运行时与 Pg 适配器的导入统一限制在 `core/database/client.ts`，其他服务端文件只引用 Prisma 类型。生命周期测试检查 HTTP 契约、SSE/ASR/世界连接关闭、失败启动后的再次启动，以及共享数据库客户端的释放顺序和重复关闭。Vitest 使用线程池，避免 Colyseus 的 PM2 遥测占用 fork 的测试 IPC，不模拟服务器本身。

UI 沙箱统一放在 `test/sandbox`。新增 `asr-services-fixture.ts` 提供确定性识别结果与临时配置；仓库没有可迁移的受控 `output/asr-services-fixture.ts`。两个沙箱均通过 `createTestServer` 启动，并处理退出清理。

## 独立任务计划存档

任务计划、执行历史、预算与调度规则由 `modules/tasks/services/coordinator.service.ts` 的 `TaskCoordinator` 与 `execution.service.ts` 管理；计划调度器位于同目录的 `scheduler.service.ts`。`ai-characters/services/wake-scheduler.service.ts` 只推进 Agent 消息唤醒、等待检查和本地跟随。HTTP/WebSocket 共用同一份计划集合、执行历史和计划调度器。

`persistence/plan-store.ts` 持有计划与执行历史的内存状态，继续导出 `TaskPlanService` 和别名 `PlanService`；快照与恢复仍由该目录负责。`domain/command-policy.ts` 的 `taskCommandBody` 仅为幂等命令指纹剔除 `expectedTask`、`expectedPlanRevision`，不承担输入白名单校验。`routes/tasks.routes.ts` 保留 `/tasks` 与 `/task-runs` 的 HTTP 路由和 OpenAPI 注解。所有现有公共导出继续通过模块根部 `index.ts` 提供，目录调整不改变类名、函数签名或存档格式。

Agent 与任务通过 v3 的 characters/plans/runs/requests 聚合快照保存至 PostgreSQL，嵌入的运行时状态为 version 4，Pi 检查点为 v3。存档恢复前经过结构校验，不再兼容 v0/v1/v2 历史存档或读写旧 Agent JSON 文件。删除角色保留计划与执行历史；聊天执行没有 planId。部署与回滚流程见 [Agent Gateway](../../docs/agent/gateway.md)。

## HTTP 领域路径

共享模型配置使用 `/providers`，全局计划使用 `/tasks`，运行控制使用 `/task-runs`，TTS 配置和试听使用 `/voice/tts/services`，Piper 模型目录与安装使用 `/voice/tts/piper`。它们与 `/ai-characters`、`/voice/asr/services` 都需要管理员 Bearer 令牌。Agent 音色绑定继续为 `/ai-characters/:id/voice`；聊天音频继续使用 `/chat` 下的玩家会话鉴权。

这些路径替换旧的 `/ai-characters/providers`、`/ai-characters/tasks`、`/ai-characters/task-runs`、`/ai-characters/voice-services`；没有旧路径别名。浏览器、CLI 脚本和外部 HTTP 客户端需要同步升级。WebSocket 连接地址仍为 `/ai-characters/gateway`。

Swagger 按领域分组，使用当前站点作为服务器地址；管理令牌与聊天会话令牌使用两个独立的授权入口。

Agent 的 `/task`、`pause`、`resume`、`cancel` 四个 HTTP 接口及 Gateway 的 `tasks.assign/pause/resume/cancel` 已移除。即时任务使用 `/tasks` 创建即执行；执行控制使用 `/task-runs/:runId/:operation`。计划 pause/resume 只控制后续调度；执行 resume 需要先通过 join 上线，并保留原执行进度与用量。CLI 示例与迁移说明见 [Agent Gateway](../../docs/agent/gateway.md)。

`POST /ai-characters` 只创建角色，默认上线待命；`joinWorld: false` 仅保存离线角色。`PUT /ai-characters/:id` 只修改角色配置，不通过目标变化隐式创建或替换任务。两者均拒绝 `startTask`、`taskTimeZone` 和非空 `goal`，返回 400 并提示使用 Tasks；空 `goal` 不会清空任务。原有存档、进度、用量与执行历史保留。

Agent 内部旧的 `resume`、`assignTask`、`controlTask` 已删除。Tasks 通过 `TaskHostPort` 操作窄化的执行状态，Agent 负责启动、中断、退出与世界连接；HTTP/Gateway 直接调用 Tasks，内部任务调用使用 `characters.tasks`。聊天暂停/取消同时校验任务身份和玩家权限，并按命令 ID 去重；任务在中断等待期间完成时保留完成结果。职责与事务说明见 [Agent Gateway](../../docs/agent/gateway.md)。
