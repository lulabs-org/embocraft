# AI Characters 模块架构设计

本文记录 `apps/server/src/modules/ai-characters` 的职责边界、分层架构与目录规范。

## 数据所有权

PostgreSQL 是角色配置、已提交状态、恢复检查点和历史日志的权威来源。`AICharacterRegistry` 只持有在线（含正在上线、下线）角色的运行实例，不能用它判断角色是否存在或统计已保存角色数量。

- 创建离线角色直接提交数据库，不分配常驻运行实例。上线时读取角色和恢复检查点；下线或连接失败后释放实例和唤醒定时器。
- `CharacterOperations` 为单次管理或任务命令按需加载离线角色，命令结束后释放临时状态，并防止同一角色的命令并发修改。离线角色仍可修改配置、安排定时任务、查询历史和删除。
- 角色配置变更通过显式的 `create` / `profiles` / `remove` 提交；普通运行检查点不能覆盖数据库配置，也不能删除未参加本次提交的离线角色。保存数量上限在数据库事务内检查。
- 角色与任务仍在同一事务内提交。删除角色会解除计划绑定并结束未完成执行，保留执行历史；被删除角色的迟到检查点不能重新创建角色。
- 正常联合提交携带计划、执行和幂等记录的显式增删改，在同一数据库事务与提交锁内校验修改前的值；已变化或已删除的记录返回冲突，不能由旧内存副本覆盖或重建。任务读取仅覆盖变更记录、当前角色检查点及其引用，删除角色时还检查其关联任务。
- `DatabaseManagementArchive` 保留启动恢复、完整导入及兼容调用的全量存档路径。正常提交仍读取全部角色及日志，任务差异仍由内存任务簿与上次成功提交的基线计算；任务调度尚未迁移到数据库，也不是多实例执行调度机制。
- `CharacterSnapshots` 只跟踪在线实例的提交状态，通知系统只缓存摘要以识别变更。存储失败后保留角色 ID 的阻断标记，避免释放实例后绕过失败保护。
- 历史日志独立追加存储；运行实例和 `list()` 的最近日志窗口仍有上限，裁剪窗口不会删除数据库历史。暂未设置历史日志自动过期策略。
- `CharacterReadPort` 负责内部按需读取：单个角色仅加载自身配置、状态、当前 Run 检查点和最近 500 条日志；服务引用检查只查询是否存在匹配角色。`list()` 通过数据库关联查询组装视图，会话 ID 从在线实例补充。
- `CharacterQueries` 同时提供内部读取和 HTTP 查询；`TaskQueries` 负责计划与历史的数据库查询、筛选、排序和分页。日常查询不再加载联合存档。`ManagementStore` 将这两个查询端口与现有联合写入端口装配到同一数据库。

启动恢复会逐个规范化已保存记录和任务检查点，临时恢复对象随处理结束释放；只有需要自动上线且满足在线数量限制的角色进入注册表。

## 1. 模块职责与边界

`ai-characters` 模块负责：

- **角色配置与生命周期用例（Application）**：管理 AI 角色的创建、更新、删除、上线（`join`）、离线（`stop`）、语音回复开关及历史日志分页查询；在服务启动时从存档恢复角色状态并按策略自动上线。
- **纯业务规则与领域校验（Domain）**：校验角色配置、动作权限（`permissions`）、技能（`skills`）、模型与轮询间隔等规则，管理内存运行日志窗口的清洗与追加。
- **进程内运行态与世界会话宿主（Runtime）**：维护在线角色的内存注册表（`AICharacterRegistry`），驱动 Colyseus 房间会话（`AICharacterHost`）、AgentRuntime 执行循环、世界事件接收（`handleWorldEvent`）与定时唤醒调度（`AICharacterWakeScheduler`）。
- **跨模块协作与防腐适配（Integrations）**：将角色运行态 `Job` 适配为 `tasks` 模块所需的 `TaskExecutionState`，以及协调 `tts` 模块的语音服务校验、会话绑定与领域事件通知。
- **数据库读写与快照转换（Persistence）**：提供面向内部管理和 HTTP 读路径的 PostgreSQL 直查（`CharacterQueries`），以及面向联合事务（`DatabaseManagementArchive`）的配置/状态/日志持久化转换与内存快照比对（`CharacterSnapshots`）。

`ai-characters` 模块不负责：

- 任务计划（Plan）与任务运行记录（Run）的生命周期管理、排队及定时触发；这些属于 `tasks` 模块。
- 模型供应商（Provider）的增删改查、密钥加解密与模型目录探测；这些属于 `providers` 模块。
- 语音合成（TTS）底层协议与音频生成；本模块仅通过 `integrations/voice-coordinator.ts` 校验引用并发布会话绑定事件。

---

## 2. 目录结构

```text
apps/server/src/modules/ai-characters/
├── README.md                                  # 模块职责边界、分层设计与目录规范文档
├── index.ts                                   # 模块唯一对外门面
├── ports.ts                                   # 跨模块与 HTTP 层契约（CharacterQueryPort、AICharacterRoutePort、CharacterDetail）
│
├── application/                               # 角色管理用例与模块生命周期编排
│   ├── character-orchestrator.ts              # 模块生命周期根协调器（含 AICharacterManager 与运行时实例绑定）
│   ├── character-management.ts                # 角色 CRUD 与上下线用例（create / update / remove / join / setVoice）
│   ├── character-operations.ts                # 单次命令的角色加载、互斥与释放
│   ├── character-restore.ts                   # 启动时从存档恢复角色 Job 与自动上线判定
│   ├── character-log-query.ts                 # 历史日志分页与游标编解码用例
│   └── character-log-query.test.ts            # 历史日志分页与游标单元测试
│
├── domain/                                    # 与传输、存储和外部模块运行时无关的角色规则
│   ├── character-settings.ts                  # 角色配置、权限、技能校验与默认值计算
│   ├── activity-log.ts                        # 角色运行日志条目的裁剪、清洗与追加规则
│   └── activity-log.test.ts                   # 运行日志裁剪与清洗单元测试
│
├── runtime/                                   # 进程内运行状态、世界会话宿主与唤醒生命周期
│   ├── character-registry.ts                  # 内存 Job 实体、AICharacterRegistry 与状态谓词
│   ├── character-execution.ts                 # 角色启动、唤醒、停止与存储失败保护
│   ├── character-host.ts                      # 单个角色的 Colyseus 会话连接与 AgentRuntime 驱动
│   ├── execution-context.ts                   # Host 与 Execution 之间的运行时回调契约
│   ├── wake-scheduler.ts                      # 角色定时唤醒计时器管理
│   └── world-event-handler.ts                 # 世界事件接收、消息入队与触发唤醒
│
├── integrations/                              # 与其他业务模块（tasks / tts）之间的转换与协作
│   ├── task-execution-adapter.ts              # 将内部 Job 适配为 tasks 模块所需的 TaskExecutionState
│   └── voice-coordinator.ts                   # 与 tts 模块及领域事件的语音校验、会话绑定
│
├── persistence/                               # 数据库查询、存档转换与提交快照对比
│   ├── index.ts                               # 供联合事务（DatabaseManagementArchive）消费的存储导出入口
│   ├── character-record.ts                    # CharacterRecord 类型与持久化设置字段提取
│   ├── character-queries.ts                   # 面向 HTTP 读路径的 Prisma 直查实现
│   ├── character-storage.ts                   # 面向联合事务的 Prisma 表写入与恢复转换
│   └── character-snapshots.ts                 # 内存态与已提交存档的快照对比及故障回滚判定
│
└── routes/                                    # Express HTTP 入站路由
    ├── ai-characters.routes.ts                # 路由定义与 OpenAPI 注释
    ├── ai-characters.routes.test.ts            # 路由集成测试
    └── ai-characters.routes.injection.test.ts # 路由查询端口注入测试
```

---

## 3. 各层依赖方向约束

```text
routes/ ──> ports.ts + application/
                │
                ├──> domain/
                ├──> runtime/ ──> domain/ + integrations/
                ├──> integrations/
                └──> persistence/ ──> ports.ts + domain/ + runtime/character-registry.ts
```

1. **`domain/`**：最内层纯规则，不依赖 Express、Prisma、Colyseus 会话或本模块其他子目录。
2. **`runtime/`**：负责进程内 `Job` 状态、Colyseus 会话与定时器，依赖 `domain/` 与 `integrations/`，不反向依赖 `application/`、`persistence/` 或 `routes/`。
3. **`integrations/`**：隔离与 `tasks`、`tts` 模块的协作细节，避免跨模块适配逻辑散落在业务用例与宿主中。
4. **`persistence/`**：负责 Prisma 读写与快照结构转换，不依赖 `application/` 或 `routes/`。
5. **`application/`**：组装并协调 `domain/`、`runtime/`、`integrations/` 与 `persistence/`，对外实现 `ports.ts` 中的契约。
6. **`routes/`**：仅处理 HTTP 请求参数、响应格式与幂等包装（`consoleSync`），通过 `ports.ts` 和 `application/` 完成调用，不直接操作 `runtime/` 或 `persistence/`。

---

## 4. 文件重构映射表

| 原路径                                     | 重构后路径                                           | 说明                                                                             |
| :----------------------------------------- | :--------------------------------------------------- | :------------------------------------------------------------------------------- |
| `services/orchestrator.service.ts`         | `application/character-orchestrator.ts`              | 合并原 `AICharacterOrchestrator`、`AICharacterManager` 与活跃实例绑定            |
| `services/character-manager.service.ts`    | `application/character-orchestrator.ts`              | 并入 `character-orchestrator.ts`，消除冗余单文件包装                             |
| `services/character-runtime.service.ts`    | `ports.ts` / `application/character-orchestrator.ts` | `AICharacterRoutePort` 迁入 `ports.ts`；绑定函数迁入 `character-orchestrator.ts` |
| `services/character-management.service.ts` | `application/character-management.ts`                | 角色 CRUD 与上下线用例编排                                                       |
| `services/character-restore.ts`            | `application/character-restore.ts`                   | 启动恢复角色用例                                                                 |
| `services/character-log.service.ts`        | `application/character-log-query.ts`                 | 日志分页与游标查询用例                                                           |
| `services/character-log.service.test.ts`   | `application/character-log-query.test.ts`            | 日志分页单元测试                                                                 |
| `domain/validation.ts`                     | `domain/character-settings.ts`                       | 角色配置、权限、技能校验规则                                                     |
| `domain/activity-log.ts`                   | `domain/activity-log.ts`                             | 保持在 `domain/`                                                                 |
| `services/character-job.ts`                | `runtime/character-registry.ts`                      | 内存 `Job` 模型、注册表与状态谓词                                                |
| `services/character-execution.service.ts`  | `runtime/character-execution.ts`                     | 角色执行、唤醒、停止与存储失败保护                                               |
| `services/character-host.service.ts`       | `runtime/character-host.ts`                          | Colyseus 会话宿主与 `AgentRuntime` 驱动                                          |
| `services/execution-context.ts`            | `runtime/execution-context.ts`                       | 运行时宿主回调上下文契约                                                         |
| `services/wake-scheduler.service.ts`       | `runtime/wake-scheduler.ts`                          | 角色唤醒定时器调度                                                               |
| `services/world-event-handler.ts`          | `runtime/world-event-handler.ts`                     | 世界事件接收与唤醒触发                                                           |
| `services/task-execution-adapter.ts`       | `integrations/task-execution-adapter.ts`             | 适配 `tasks` 模块的 `TaskExecutionState`                                         |
| `services/voice-coordinator.service.ts`    | `integrations/voice-coordinator.ts`                  | 协调 `tts` 模块校验与语音会话事件                                                |
| `persistence/queries.ts`                   | `persistence/character-queries.ts`                   | PostgreSQL 直查实现                                                              |
| `persistence/record.ts`                    | `persistence/character-record.ts`                    | `CharacterRecord` 与持久化字段提取                                               |
| `persistence/character-storage.ts`         | `persistence/character-storage.ts`                   | 保持在 `persistence/`                                                            |
| `services/character-snapshots.ts`          | `persistence/character-snapshots.ts`                 | 归入 `persistence/`，与 `tasks/persistence/snapshots.ts` 对齐                    |
