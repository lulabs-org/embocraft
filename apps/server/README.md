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
| `modules/console-sync`  | 控制台指令路由、幂等回执与状态变更事件               |
| `modules/ai-characters` | 生产依赖注入、Agent 生命周期编排与配置文件适配       |
| `modules/providers`     | 模型提供商持久化存储与模型列表服务                   |
| `modules/tasks`         | 任务计划、运行历史与执行控制领域服务                 |
| `modules/gateway`       | 管理令牌与 WebSocket 状态通知                        |
| `modules/asr`           | ASR 配置存储、Whisper/百炼识别、调度、转写与能力路由 |
| `modules/tts`           | 音色服务存储、Piper/远程合成、模型状态与管理路由     |
| `modules/chat`          | 消息、附件、音频票据及私聊权限                       |
| `modules/world`         | 权威物理房间、Schema、持久化、SSE、Agent 语音与信令  |

`asr/engines/whisper/whisper.adapter.ts` 负责通过独立语音服务 API 进行 Whisper 识别。Piper 模型和声音服务的管理路由归 `tts`，HTTP 地址为 `/voice/tts/services`；Agent 音色绑定由 Agent 管理器处理，删除服务通过领域事件检查角色引用，音频模块不反向依赖 Agent。`character-manager.service.ts`、`orchestrator.service.ts` 位于 `ai-characters/services/`，Provider 仓储契约与数据库实现归属 `providers/persistence/`，`tasks` 模块按 `domain/`、`services/`、`persistence/` 和 `routes/` 分层；`ports.ts` 集中声明管理接口、执行状态与宿主契约。角色与任务的数据库映射分别归属 `ai-characters/persistence` 与 `tasks/persistence`，`src/persistence/database-management-archive.ts` 在同一事务中调用两者。应用层串行保存后更新已提交视图，再调用提交通知回调；`application/management-persistence.ts` 连接快照参与者、失败保护和提交通知；角色编排器提供参与者并连接 `ConsoleSyncEvents.commit()`。角色运行快照及恢复位于 `ai-characters/services/`，存储失败后由执行服务保护受影响的角色。

全局 `persistence/` 提供跨模块存档契约、联合数据库事务驱动与结构规整；联合数据库驱动只通过角色和任务的持久化门面使用它们各自的数据映射，不依赖运行时或 HTTP。串行提交协调位于 `application/management-commit.ts`，任务模块不反向依赖全局存档层。`storageRevision` 只在保存失败时递增，`flush(since)` 只等待已排队的保存并检查失败代次，不捕获新快照。

业务错误与通用异常统一使用 `core/errors/app-error.ts` 中的 `AppError`。复用 Origin 判断和异常处理机制不意味着统一所有端点的策略：保留语音接口允许无 Origin、管理接口的 Origin 校验、原有预检方法、JSON/原始音频限制以及错误状态和文案。Swagger 扫描 `core/http`、`core/openapi` 和 `modules` 下的 `*.routes.ts`，以及 `modules` 下的 `routes.ts`。

Agent 托管集合、唤醒调度、生命周期操作和日志位于 `modules/ai-characters`，任务计划、执行控制与计划调度位于 `modules/tasks`，模型提供商归入 `modules/providers`。各模块高内聚低耦合，不再依赖外部编排包。HTTP 路由和 OpenAPI 注释由各领域维护，`server.ts` 装配服务器；角色编排器仍负责绑定角色、任务和控制台服务，以及协调 Provider 与语音服务事件。共享请求策略与管理路由构建 `createManagementRouter` 位于 `core/http/middleware/management-policy.ts`，回执路由位于 `modules/console-sync/routes/console-sync.routes.ts`。TTS 复用同一请求策略，但不进入命令回执队列；ASR 配置保留 8 KiB JSON 和专用错误映射，转录保留原始音频请求体。通过 `req.baseUrl + req.path` 保留命令指纹使用的完整请求路径。

`console-sync/services/` 集中 `console-sync.service.ts` 与 `sync-events.service.ts`，命令服务测试与源码共置。`core/concurrency/command-router.ts` 为通用队列提供错误策略，`ConsoleSyncCommands` 负责 HTTP 命令标识与指纹输入，`ConsoleSyncEvents` 计算快照差异并通知订阅者。公共回执与错误契约继续由 `@voxel/shared/management` 提供；模块不重复定义回执模型。根部 `index.ts` 保留全部公开导出，幂等指纹、排队顺序、回执状态、错误映射及事件通知行为保持不变。

`ai-characters/services/` 中，`orchestrator.service.ts` 协调各服务及启动、恢复和关闭；`character-management.service.ts` 负责角色创建、配置修改、加入与删除；`character-execution.service.ts` 负责执行、唤醒和停止；`character-host.service.ts` 维护单个角色的世界会话和 Agent 执行。生产装配包装器为 `character-manager.service.ts`。`character-job.ts`、`execution-context.ts`、`task-execution-adapter.ts` 与 `world-event-handler.ts` 是同层运行时辅助文件，保留会话、Runner 与任务状态适配职责。HTTP 路由和 OpenAPI 注解位于 `routes/ai-characters.routes.ts`，纯校验与日志留在 `domain/`，角色快照留在 `persistence/`。模块根部 `index.ts` 保留全部公开导出；目录调整不改变角色生命周期、唤醒时序、语音行为、接口或存档格式。

`env.readServer()` 校验网关令牌和来源配置。`gateway/auth.service.ts` 为 HTTP 管理路由和 WebSocket 握手提供令牌比对与来源检查，`gateway.socket.ts` 负责握手、事件订阅与连接清理。

`providers` 保留现有 `domain/`、`adapters/`、`persistence/`、`services/` 和 `routes/` 分层。服务与就近测试统一命名为 `services/provider.service.ts` 和 `provider.service.test.ts`；模块门面导出 `ProviderService`、`providerService`、`providerRepository` 与零参 `createProviderRouter()`，删除引用检查与变更广播通过 `core/events/domain-events.ts` 事件总线协作。

`ModelCatalog` 由 `ProviderService` 默认组装，`agentDependencies` 仅配置角色的 session 与 runner。删除模型或音色服务通过 `domainEvents` 事件守卫与数据库外键检查关联约束。

Agent 共用运行时继续位于 `packages/agent-runtime`，不迁入服务端。每个 Job 持有一个 `AgentRuntime`，服务端通过其消息、执行、控制、查询和恢复方法操作角色；CLI 使用同一门面的 `runUntilSettled()`。宿主不再自行解析控制词、拼接事件标识或读写运行时分区；任务账本、连接、定时器和联合存档事务仍由服务端管理。已删除 `Job.memory/attention` 别名；运行时存档使用 version 4 的角色/执行双分区，旧运行时存档会明确报错，不自动迁移。

`chat` 按 `domain/`、`services/`、`persistence/` 与 `routes/` 分层：`domain/visibility.ts` 按消息范围、发送者与接收者判断可见性；`services/` 集中聊天、凭据、音频缓存、空间语音票据、运行期绑定及 ASR 协调，统一使用 `*.service.ts` 命名；`routes/chats.routes.ts` 通过零参 `createChatRouter()` 挂载 `/chat` 的 HTTP 接口与 OpenAPI 注解。路由和语音协调测试与源码共置，跨包的 `test/chat.test.ts` 保留在集成测试目录。模块门面导出 `WorldChat`、`createChatRouter`、`bindChatRuntime` 与 `visibleEvent`，聊天鉴权、可见性、语音处理和票据生命周期保持不变。

`world` 的地形、玩家名称和输入/编辑校验规则归入 `domain/`，数据库存储与就近测试归入 `persistence/`，HTTP/SSE 路由与测试归入 `routes/worlds.routes.ts` 及同名测试文件。`world.room.ts` 与 `world.schema.ts` 留在模块根部，分别负责 Colyseus 房间生命周期与同步状态 Schema；Schema 依赖框架，不属于纯领域规则。模块门面导出 `WorldRoom`、`getActiveWorld`、`WorldStore` 和零参 `createWorldRouter`（合并 `/world` 与 `/world/presence`）。Schema 字段与注册顺序、物理模拟、持久化、房间生命周期及 `/world`、`/world/presence` 行为保持不变。跨共享物理实现的世界规则测试与服务器生命周期测试保留在 `test/`。

音频能力按职责拆为 `core/audio`、`modules/asr`、`modules/tts` 三部分，空间语音与 Agent 发声归入 `modules/world`：

- `core/audio/` 只放无业务状态的共享基础设施：`pcm-wav.ts`（无 I/O 的 PCM WAV 格式、时长与音量校验）、`normalize.ts`/`command.ts`（FFmpeg、子进程与临时文件处理）、`speaches-models.ts`（Speaches 模型与音色发现）以及 `voice-service-connection.ts`（ASR/TTS 共用的连接参数校验）。该目录只依赖 `core`。
- `modules/asr/` 按 `persistence/`、`services/`、`routes/`、`sockets/` 分层。`routes/asr.routes.ts` 暴露零参 `createAsrRouter()`，挂载 `capabilities → transcribe → asr` 路由，管理鉴权由 `server.ts` 统一前置；`sockets/asr.socket.ts` 的 `installAsrSocket` 注册 `/voice/asr/realtime`。门面导出 `createAsrRouter`、`AsrService`、`asrService`、`DatabaseAsrServicePersistence`、`installAsrSocket`、`AsrBridge`、`LocalSpeech`、`localSpeech` 与 `scheduleSpeech`。`/voice/capabilities` 同时报告 Whisper 与 Piper 状态，经 `tts` 门面读取 `PiperModels`。
- `modules/tts/` 按 `persistence/`、`services/`、`routes/` 分层，合成契约位于 `services/speech-synthesizer.ts`，无状态领域服务位于 `services/tts.service.ts`（`TtsService` / `ttsService`）。`routes/tts.routes.ts` 的零参 `createTtsRouter()` 通过 management 管线注册 `/voice/tts`。门面导出 `createTtsRouter`、`TtsService`、`ttsService`、`DatabaseVoiceServicePersistence`、`PiperTts`、`PiperModels` 与 `SpeechSynthesizer`。跨模块音色绑定与变更通过 `core/events/domain-events.ts` 事件总线协作，`tts` 不依赖 `asr`、`chat`、`ai-characters` 或 `world`。
- 两个服务仍包含原有校验与运行时协调职责，支持注入持久化适配器；生产使用 PostgreSQL，测试使用内存实现或 `vi.mock`。默认数据、串行写入、数据库事务、识别占用、音色绑定及删除保护行为保持不变。

`AgentSpeech` 位于 `modules/world/services/agent-speech.service.ts`，负责语音合成队列、空间听众筛选和音频缓存访问。`WorldRoom` 装配它并通过 `bindChatRuntime` 单向绑定到 `chat` 模块，在聊天消息送达后入队，在关闭语音、离线、音色服务变更或房间销毁时取消或清理，避免 `chat → world` 的循环依赖。空间信令由 `modules/world/services/spatial-signaling.service.ts` 提供，通过 `WorldRoom` 消息转发，没有独立 Socket 端点。Agent 核心调度不依赖这些服务。

## 结构验收

本轮目录与命名整理已完成。架构测试位于 `tests/server-boundaries.test.ts`，检查跨模块门面、依赖方向、Socket 契约、循环依赖及再导出形成的间接 HTTP 依赖。`core/openapi/swagger.test.ts` 扫描全部服务端非测试 TypeScript 文件中的显式 `app.get/post/put/patch/delete` 注册；动态路径、Router 别名和 `app.use` 不在当前覆盖范围。测试反例验证再导出和非路由文件中的新增路由不能绕过已有检查。WebSocket 长连接接口（`/voice/asr/realtime` 与 `/ai-characters/gateway`）通过 `core/openapi/asyncapi.ts` 提供 AsyncAPI 3.0 规范，可通过 `/asyncapi-docs` 查阅交互式文档或通过 `/asyncapi.json` 获取协议定义。ASR/TTS Store 的校验、运行时协调和持久化职责保持现状，进一步拆分需单独评估。

## 状态与测试

`dataPath()` 锚定仓库根目录，Docker 中对应 `/app/.data/`。生产默认将模型提供商、Agent/任务联合存档和 TTS/ASR 配置保存在 PostgreSQL；网关通过环境变量 `AGENT_GATEWAY_TOKEN` 配置令牌，本地语音模型文件保留原配置位置。现有数据库存档恢复与运行时迁移继续保留。

角色与执行快照在当前 schema 中按所有权分开保存：

- `AgentCharacter` 保存明确的配置列和排序，不再保存整个 `AICharacterView`。可空配置列保留旧存档中“字段缺失”的语义，加载时仍由领域校验补默认值；权限和技能作为小型结构化 JSON 保留。
- `AgentCharacterState` 保存恢复用的状态、当前 Run ID、runtime 版本及角色长期 `memory`（对话、收件箱、累计用量）。无当前任务时，`standby` 保留待命回复和诊断状态；有当前 Run 时不保存执行快照。
- `AgentCharacterLog` 按角色和递增序号保存日志。追加和截断只写入新增、删除过期条目，不重写配置和保留的日志；时间允许为空，继续遵循原有最多 500 条的行为。

- `AgentRunCheckpoint` 通过 Run ID 一对一保存版本号和执行分区（任务身份、模型上下文、动作结果、未确认副作用、健康状态）。`AgentRun.data` 只保存执行元数据，不再嵌套 runtime；删除 Run 会级联删除 checkpoint。

角色、日志、Run 元数据、checkpoint 和任务表仍在同一事务中提交，失败时不推进内存中的已提交状态。执行快照单独变化时不重写角色记忆或 Run 元数据。角色删除会级联删除状态和日志。

角色列表、详情和日志的 HTTP 读取通过查询端口访问数据；`server.ts` 将 `ai-characters/persistence/character-queries.ts` 的 Prisma 实现注入路由，不经过编排器或内存快照缓存。查询文件集中组装角色配置、服务名称、当前执行 checkpoint、待执行任务与用量；HTTP 列表与详情不读取日志，历史日志按序号在数据库中分页。内部角色读取使用同一实现：单个恢复记录只查询目标角色、当前 Run 检查点和最近 500 条日志；内部视图附带最近日志窗口，服务引用检查只查询匹配记录是否存在。关联读取和日志计数/分页使用 `RepeatableRead` 事务，避免混合不同提交的数据。路由只补充实时 `sessionId` 和查询开始前的管理事件版本号；写操作等待保存成功后也通过同一查询返回。`ai-characters/persistence/character-snapshots.ts` 保留提交和任务控制所需的已提交记录，并判断保存失败涉及的角色，不再保存 HTTP 响应副本。无数据库的测试显式注入读取已保存测试存档的查询实现，生产环境不回退到内存查询。

读取数据库时，将角色最新记忆与当前 Run 的 checkpoint 组合成运行时完整快照；缺失、归属错误或不一致的当前执行会拒绝加载或保存。组合后的角色与 Run 对象互不共享可变执行引用。内存运行时和归档端口保留完整快照形状，Run 快照中的角色分区为空；恢复历史执行只替换执行分区，保留最新对话、收件箱、节奏和累计用量。暂停、私聊过期与不重放未知动作的恢复规则保持不变。

数据库结构变更使用 Prisma Migrate：开发时运行 `pnpm db:migrate --name <change>` 创建并应用新迁移，再运行 `pnpm db:generate`；CI 和 Docker 通过 `pnpm db:deploy` 应用已提交的迁移，不运行交互式 `migrate dev`。Prisma 7 不会在迁移后自动生成客户端。已应用的迁移文件不得修改；如果出现校验和冲突，应从版本控制或备份恢复当时的原文件，再追加迁移，不通过 `db push`、修改 `_prisma_migrations` 或自动 reset 绕过。

`20261101013936_split_character_execution_storage` 补齐角色配置、长期记忆、日志和 Run checkpoint 的结构变更。该迁移不搬迁旧存档，会删除 `AgentCharacter.data`，适用于空库或已重置的开发库；需要保留旧数据的环境必须先另行准备数据迁移方案。运行数据库测试时使用独立的 `TEST_DATABASE_URL`，测试会清空该测试库中的业务表。

`test/helpers/test-server.ts` 使用生产 `createServer()`，通过环境变量设置测试用网关令牌，在专用测试数据库和随机本地端口上运行服务。`close()` 恢复环境变量并清理工厂创建的临时目录。

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

`tasks/persistence/plan-store.ts` 保留任务写入和调度所需的内存状态，继续导出 `TaskPlanService` 和别名 `PlanService`；快照与恢复仍由该目录负责。

查询通过 `TaskQueryPort` 注入 `tasks/persistence/task-queries.ts`：计划详情按 ID 读取，列表筛选、排序、计数和每页 20 条的分页在数据库执行；历史按计划查询并排除聊天执行，活跃执行独立于历史分页返回。关联读取与计数/分页使用 `RepeatableRead`，角色名称取当前配置，历史执行保留原角色归属和名称。

`ManagementStore` 将角色查询、任务查询与联合存档写入装配在同一数据库。正常联合提交在串行队列内，以最近一次成功提交为基线计算任务的显式增删改；数据库在提交锁内只读取受影响的计划、执行、幂等记录及当前角色检查点依赖，校验修改前的值后写入。未修改的数据库任务保留，过期修改和删除返回 409，角色、任务及 Token 用量一起回滚。已有排序位置保留，新记录在数据库当前最大位置后追加。

启动恢复以原始存档为提交基线，规范化和恢复操作作为真实变更保存。完整导入和兼容的全量提交仍使用原路径。当前还保留完整的内存任务簿、提交基线及调度器；正常提交也仍读取全部角色与日志。冲突沿用存储失败保护，需要重新加载服务后恢复，不代表已支持多实例执行调度。

`console-sync` 的 `commandReceiptBody` 仅为幂等命令指纹剔除 `expectedTask`、`expectedPlanRevision`，不承担输入白名单校验。`routes/tasks.routes.ts` 通过零参 `createTaskRouter()` 保留 `/tasks` 与 `/task-runs` 的 HTTP 路由和 OpenAPI 注解。所有公共导出通过模块根部 `index.ts` 提供。

Agent 与任务通过 v3 的 characters/plans/runs/requests 聚合快照保存至 PostgreSQL，嵌入的运行时状态为 version 4，Pi 检查点为 v3。存档恢复前经过结构校验，不再兼容 v0/v1/v2 历史存档或读写旧 Agent JSON 文件。删除角色保留计划与执行历史；聊天执行没有 planId。部署与回滚流程见 [Agent Gateway](../../docs/agent/gateway.md)。

## Plan / Run 结构化迁移

`20261101033833_structure_plans_runs` 将 Plan / Run 的归属、状态、时间、用量和请求信息改为独立列存储。计划调度拆成 `scheduleKind` / `scheduleSpec`；限制、执行输入快照、任务详情、日志和动作仍使用独立 JSON 列。执行检查点继续只存于 `AgentRunCheckpoint`。

迁移直接删除两个 `data` 列并新增结构化列，不执行旧 JSON 的回填或校验，适用于空表或已重置的开发库。`latestRun` 继续由查询层派生，执行检查点保留在独立表中。

在目标 `DATABASE_URL` 下执行 `pnpm db:deploy` 后启动新版本。

数据库时间与领域/API 的毫秒数由适配器转换；累计 Token 使用 `BIGINT`，接口仍使用安全整数 `number`。保留 `position` 和联合快照提交方式；计划和执行历史已通过独立查询端口在数据库分页。

使用已完成迁移的独立测试库验证：

```bash
TEST_DATABASE_URL="$TASK_TEST_DATABASE_URL" pnpm exec vitest run apps/server/test/database-persistence.test.ts
```

持久化测试会清空该测试库的业务表，请勿指向业务数据库。

## 任务与语音关系约束

`20261101040046_task_voice_relations` 增加以下数据库关系：

| 引用                                                     | 删除规则 / 约束                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `AgentPlan.characterId` → 角色                           | 删除角色解除指派，保留计划                                                      |
| `AgentRun.characterId` → 角色                            | 删除角色解除有效引用；`characterIdSnapshot` 保留历史角色 ID，API 继续展示原归属 |
| `AgentRun.planId` → 计划                                 | 有执行历史时禁止删除计划；聊天 Run 可以没有计划                                 |
| `AgentCharacterState.currentRunId` + `characterId` → Run | 当前执行必须属于该角色，且必须存在对应检查点                                    |
| `AgentCharacter.voiceServiceId` → TTS                    | 被角色引用时禁止删除；清空配置用 SQL NULL                                       |
| `AgentRequest.planId` → 计划                             | 计划删除时清理幂等键；同一个键不能被存档写入改派到另一计划                      |
| `AgentRun(planId, requestId)`                            | 同一计划的手动执行请求唯一，不同计划可以使用相同请求 ID                         |
| `AsrAssignment.use` → ASR 服务                           | 用途限定为 chat / spatial / clip，每个用途最多一条；删除服务清理显式分配        |

当前执行使用即时检查的外键。联合事务先解除需要切换或删除的当前执行引用，保存角色配置、计划、Run 和检查点后再保存角色恢复状态；中间状态不会对外可见。角色的长期记忆仍独立于 Run 检查点。

ASR 显式分配改用 `AsrAssignment`，服务目录与分配在同一事务中保存。缺少显式分配时继续使用现有的默认选择规则；clip 的 Whisper 能力要求仍由服务层校验。迁移直接删除旧 `uses` 列，不回填既有分配或历史角色快照，适用于空库或已重置的开发库。

## HTTP 领域路径

共享模型配置使用 `/providers`，全局计划使用 `/tasks`，运行控制使用 `/task-runs`，TTS 配置和试听使用 `/voice/tts/services`，Piper 模型目录与安装使用 `/voice/tts/piper`。启用鉴权时，这些接口与 `/ai-characters`、`/voice/asr/services` 都需要管理员 Bearer 令牌。Agent 音色绑定继续为 `/ai-characters/:id/voice`；聊天音频继续使用 `/chat` 下的玩家会话鉴权。

这些路径替换旧的 `/ai-characters/providers`、`/ai-characters/tasks`、`/ai-characters/task-runs`、`/ai-characters/voice-services`；没有旧路径别名。浏览器、CLI 脚本和外部 HTTP 客户端需要同步升级。WebSocket 连接地址仍为 `/ai-characters/gateway`。

Swagger 按领域分组，使用当前站点作为服务器地址；管理令牌与聊天会话令牌使用两个独立的授权入口。

Agent 的 `/task`、`pause`、`resume`、`cancel` 四个 HTTP 接口及 Gateway 的 `tasks.assign/pause/resume/cancel` 已移除。即时任务使用 `/tasks` 创建即执行；执行控制使用 `/task-runs/:runId/:operation`。计划 pause/resume 只控制后续调度；执行 resume 需要先通过 join 上线，并保留原执行进度与用量。CLI 示例与迁移说明见 [Agent Gateway](../../docs/agent/gateway.md)。

`POST /ai-characters` 只创建角色，默认上线待命；`joinWorld: false` 仅保存离线角色。`PUT /ai-characters/:id` 只修改角色配置，不通过目标变化隐式创建或替换任务。两者均拒绝 `startTask`、`taskTimeZone` 和非空 `goal`，返回 400 并提示使用 Tasks；空 `goal` 不会清空任务。原有存档、进度、用量与执行历史保留。

Agent 内部旧的 `resume`、`assignTask`、`controlTask` 已删除。Tasks 通过 `TaskHostPort` 操作窄化的执行状态，Agent 负责启动、中断、退出与世界连接；HTTP/Gateway 直接调用 Tasks，内部任务调用使用 `characters.tasks`。聊天暂停/取消同时校验任务身份和玩家权限，并按命令 ID 去重；任务在中断等待期间完成时保留完成结果。职责与事务说明见 [Agent Gateway](../../docs/agent/gateway.md)。
