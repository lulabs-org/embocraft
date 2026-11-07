# 服务端架构

`src/index.ts` 加载仓库根目录的 `.env`，启动服务并处理 SIGINT/SIGTERM。`src/server.ts` 的 `createServer()` 读取当前环境、检查数据库并装配业务服务、Express、WebSocket 和 Colyseus；导入它不会加载 `.env` 或监听端口。

## 启动与关闭

- `createServer()` 建立数据库客户端、业务路由和世界房间定义。`listen()` 监听端口、创建世界，再恢复 Agent；使用随机端口时，Agent 使用实际分配的地址。
- `close()` 可重复调用：关闭 Agent 和 Colyseus 房间，终止其他 WebSocket、HTTP/SSE 连接，最后释放存储和数据库连接。监听或恢复失败也会执行清理。
- 当前为单进程单世界模型。Colyseus 的 matchMaker 与房间占用状态属于进程；不要在同一进程同时创建多个服务器。
- PostgreSQL 由开发者单独启动和迁移。`createServer()` 创建并设置共享数据库客户端，供 Provider、世界、聊天、联合存档及 TTS/ASR 存储使用；关闭时清除共享引用并释放客户端。`core/database/client.ts` 也支持按需创建默认客户端；数据库启动探活使用独立短连接。

## 模块与依赖

| 目录                                      | 责任                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `core`                                    | 配置、数据库连接、错误、并发队列、HTTP 策略、协议文档、WebSocket 传输和共享音频工具 |
| `persistence`                             | Agent 与任务联合存档、迁移、串行提交及失败处理                                      |
| `modules/ai-characters`                   | Agent 配置、运行时、生命周期、唤醒和语音绑定                                        |
| `modules/tasks`                           | 任务计划、运行记录、调度与执行控制                                                  |
| `modules/providers`                       | 模型服务配置、模型列表和健康检查                                                    |
| `modules/asr`、`modules/tts`              | 识别与合成服务配置、适配器和接口                                                    |
| `modules/world`                           | Colyseus 世界、玩家状态、空间信令与 Agent 语音                                      |
| `modules/chat`                            | 聊天消息、附件、语音与可见性                                                        |
| `modules/console-sync`、`modules/gateway` | 控制台命令回执、变更事件和管理 WebSocket                                            |

`core` 不依赖业务模块；模块之间通过各自的 `index.ts` 引用公开能力。`server.ts` 连接模块与传输，管理 HTTP 请求的公共策略位于 `core/http/middleware/management-policy.ts`。Socket 路由契约位于 `core/transport/socket-routes.ts`；业务 Socket 适配器只以类型形式引用该契约。

Provider 的 `ProviderService` 协调配置读写、删除事件和变更通知，并默认创建模型目录和健康检查；这些默认组件通过仓储的 `getRuntime` 读取连接信息。跨模块删除检查与变更通知通过 `core/events/domain-events.ts` 协作。Agent 共用运行时位于 `packages/agent-runtime`。

## Agent、任务与存档

`AICharacterOrchestrator` 管理角色和运行时，`TaskCoordinator` 管理计划、运行记录及调度；任务通过宿主契约请求 Agent 启动或停止执行。`ManagementPersistence` 捕获角色和任务快照，串行保存联合存档；保存成功后更新已提交视图并发出通知。保存失败会推进失败代次并保护受影响的执行；`flush(since)` 等待已经排队的保存并检查失败代次，不创建新快照。

角色配置、长期记忆、日志、任务运行和执行检查点分别保存在对应数据库表中，但仍通过联合事务提交。角色列表、详情和日志从数据库查询，路由补充实时会话 ID 和事件版本；执行恢复会结合角色记忆与当前运行检查点。

## 接口与协议

管理接口包括 `/ai-characters`、`/providers`、`/tasks`、`/task-runs` 和 `/console-sync`；TTS 管理接口位于 `/voice/tts`，ASR 配置接口位于 `/voice/asr`。启用鉴权时管理请求使用 Gateway 令牌，聊天接口使用玩家会话鉴权。管理接口、语音接口和聊天接口各自保留其 Origin、请求体及错误策略。

HTTP 接口文档位于 `/api-docs` 和 `/api-docs.json`；Gateway 与实时 ASR WebSocket 协议文档位于 `/asyncapi-docs` 和 `/asyncapi.json`。更详细的 Agent、任务及部署约束见 [Agent Gateway](../../docs/agent/gateway.md)。

## 开发与验证

```sh
pnpm --filter @voxel/server lint
pnpm --filter @voxel/server build
pnpm test
pnpm check
```

就近单元测试与源码放在一起，跨模块测试位于 `apps/server/test/`；`tests/server-boundaries.test.ts` 检查模块和传输依赖方向。部分服务器和数据库测试需要已经迁移的专用 PostgreSQL 测试库：设置 `TEST_DATABASE_URL`，数据库名必须以 `_test` 结尾。测试会清空该库的业务表，不要指向业务数据库。`apps/server/test/helpers/test-server.ts` 使用生产装配、随机本地端口和该测试库。

使用 Prisma Migrate 管理结构变更：开发时运行 `pnpm db:migrate --name <change>`，随后运行 `pnpm db:generate`；部署已提交的迁移使用 `pnpm db:deploy`。不要修改已经应用的迁移文件，也不要通过自动重置或修改迁移记录解决校验和冲突。

`20261101013936_split_character_execution_storage` 会删除旧的 `AgentCharacter.data`，不搬迁旧存档，仅适用于空库或已重置的开发库；需要保留旧数据时必须先准备迁移方案。

## Plan / Run 结构化迁移

`20261101033833_structure_plans_runs` 将 Plan / Run 的归属、状态、时间、用量和请求信息改为独立列存储。计划调度拆成 `scheduleKind` / `scheduleSpec`；限制、执行输入快照、任务详情、日志和动作仍使用独立 JSON 列。执行检查点继续只存于 `AgentRunCheckpoint`。

迁移直接删除两个 `data` 列并新增结构化列，不执行旧 JSON 的回填或校验，适用于空表或已重置的开发库。`latestRun` 继续由查询层派生，执行检查点保留在独立表中。

在目标 `DATABASE_URL` 下执行 `pnpm db:deploy` 后启动新版本。

数据库时间与领域/API 的毫秒数由适配器转换；累计 Token 使用 `BIGINT`，接口仍使用安全整数 `number`。本阶段保留 `position` 和联合快照提交方式，未引入外键重构或数据库分页。

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
