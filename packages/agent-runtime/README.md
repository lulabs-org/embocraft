# Agent runtime

`@voxel/agent-runtime` 是 AI 角色的无头运行时：把玩家消息、控制指令、计划到期和动作结果统一成一次决策，驱动模型选择工具，再把工具结果变成受权限、任务归属与预算约束的世界操作。服务端托管角色与 CLI 共用同一套实现。

包按两条能力轴切开：`world/` 只懂世界协议与物理，`agent/` 只懂角色策略与模型。`api/` 是宿主唯一接触面，`contracts/` 是纯类型叶子层，`persistence/` 是唯一认识旧存档格式的地方。

> **状态**：目录结构、`kernel/` 原语、`AgentState v3` 分区、`Turn`/`ToolHost`、`api` 门面与 `./testing` 入口已完成（PR-1～PR-5），旧路径对照见[文末](#附录旧路径对照)。宿主的事件接入与任务控制已走 `api/intake` 助手；执行槽仍由 `AICharacterHost` 按原生命周期驱动，切换到 `createAgentRuntime` 是后续独立改动。

## 设计原则

新增文件放哪里，只问两个问题：

1. **它因为什么而变化**——世界协议/物理、AI 策略/模型、存档格式，还是宿主契约？
2. **它需不需要 IO**——需要就把接口留在使用方，实现放进适配器。

由此得到四条硬规则：

- **依赖单向**：只能沿 `api → agent/world/persistence → contracts` 方向 import，反向和横穿一律禁止。
- **领域无 IO**：时间、随机数、id、日志全部注入，业务规则在假时钟下可测。
- **宿主只认门面**：宿主不拼事件 id、不解析控制指令、不读写 `AgentState` 内部字段。
- **存档版本集中**：旧格式兼容只在 `persistence/migrate.ts`，升级必须附带旧档 fixture。

## 目录结构

```
packages/agent-runtime/
├── package.json            # exports: "." 与 "./testing"
├── tsconfig.json           # 独立编译单元，不依赖根 tsconfig 混编
├── README.md
└── src/
    ├── index.ts            # 只 export * from './api'
    ├── api/                # 宿主唯一接触面
    │   ├── runtime.ts      # createAgentRuntime: submit/control/run/snapshot
    │   ├── intake.ts       # WorldEvent → CharacterEvent：事件 id、控制词、审计入队
    │   └── ports.ts        # RuntimePorts（session/model/store/log/state）
    ├── contracts/          # 纯类型叶子层，只依赖 @voxel/shared
    │   ├── observation.ts  # Observation
    │   ├── action.ts       # AgentAction / ActionResult / BatchResult / NavigationResult
    │   ├── config.ts       # CharacterConfig / ModelConfig / LimitsConfig
    │   ├── state.ts        # AgentState v3、CharacterEvent、PiCheckpoint
    │   ├── tool-state.ts   # 单次 turn 的工具状态位
    │   └── errors.ts
    ├── kernel/             # 叶子原语层：取消、超时与信号组合
    │   └── abort.ts        # cancellable / withDeadline / mergeSignals
    ├── world/              # 世界交互：不懂 LLM，不懂任务策略
    │   ├── session/
    │   │   ├── port.ts     # AgentSession: observe/move/request
    │   │   └── colyseus.ts # Colyseus 实现与重连
    │   ├── observe/
    │   │   ├── extract.ts  # 观察裁剪、worldView、worldSignature
    │   │   ├── attention.ts # 纯过滤：是否为发给自己的真人消息
    │   │   ├── scope.ts    # 私聊与广播事件的可见性隔离
    │   │   └── verify.ts   # arrived / observedEmpty / 方块比对谓词
    │   ├── actions/
    │   │   ├── parse.ts    # 模型输出 → 合法动作
    │   │   ├── execute.ts  # 单动作执行
    │   │   ├── batch.ts    # 批执行与不确定结果标记
    │   │   └── build.ts    # houseBlocks 规划 + executeBuild
    │   └── nav/{map,astar,controller}.ts
    ├── agent/              # 角色智能
    │   ├── task/           # 纯策略：实体、命令、授权、租约、预算
    │   │   └── task.ts policy.ts lease.ts budget.ts commands.ts
    │   ├── turn/           # 一次决策的生命周期
    │   │   ├── turn.ts     # 显式 Turn：租约/预算/配置切换/动作槽，实现 ToolHost
    │   │   ├── wake.ts     # 一次唤醒的事件循环（包含 RunOptions）
    │   │   ├── event.ts    # 事件认领与结算
    │   │   ├── prepare.ts  # 观察、跳过未变化的等待、可见任务计算
    │   │   ├── reconcile.ts # 未确认效果与未完成建造的核对
    │   │   ├── decide.ts   # Pi Agent 装配
    │   │   ├── guards.ts   # 批次边界、截断、协议纠正
    │   │   ├── input.ts    # 模型输入构造
    │   │   ├── health.ts   # 连续失败与无进展检测
    │   │   ├── window.ts   # 转录裁剪：只保留完整交互组
    │   │   ├── transcript.ts # 转录脱敏、按受众保留与检查点写入
    │   │   └── checkpoint.ts
    │   ├── tools/          # 模型可见能力：schema + handler
    │   │   ├── port.ts     # ToolHost 接口，由 Turn 实现
    │   │   └── schema.ts conversation.ts world.ts task.ts
    │   ├── action/         # 任务绑定的动作推进
    │   │   └── executor.ts background.ts follow.ts chat-pacing.ts
    │   ├── prompt/{system,skills,view}.ts
    │   ├── model/{pi,stream,charge,failure}.ts
    │   └── schedule.ts     # headless 循环，仅 CLI 使用
    ├── persistence/        # 存档格式与迁移
    │   ├── migrate.ts      # v1/v2 → v3，唯一认识旧结构的地方
    │   └── fixtures/       # 历史档快照，迁移回归用
    └── testing/            # "./testing"：内存 Session、假模型、可控 Clock/Id
```

## 目录职责

| 目录             | 职责                                                                 | 不负责                           |
| ---------------- | -------------------------------------------------------------------- | -------------------------------- |
| `api/`           | 门面、事件接入、只读投影、端口组装                                   | 决策、工具实现、世界执行         |
| `contracts/`     | 跨层 DTO、存档形状、配置与错误类型                                   | 行为、IO、版本迁移               |
| `world/session/` | 会话端口与 Colyseus 实现、重连                                       | 任务策略、模型请求               |
| `world/observe/` | 观察提取、注意力过滤、结果核对谓词                                   | 写回内存、调度唤醒               |
| `world/actions/` | 动作解析、权限校验、单动作/批执行、建造                              | 任务归属、模型循环               |
| `world/nav/`     | 局部地图、可站立节点搜索、可取消的位置闭环                           | 任务状态、跟随意图               |
| `agent/task/`    | 任务实体、命令与授权、租约、预算计算                                 | 发起模型请求、执行世界写操作     |
| `agent/turn/`    | 一次决策的状态机、事件与转录、观察与效果核对、输入构造、守卫与检查点 | 宿主协议、具体连接实现           |
| `agent/tools/`   | 工具 schema 与 handler，只依赖 `ToolHost` 接口                       | 直接访问 Session、任务持久化细节 |
| `agent/action/`  | 任务绑定的动作执行、后台动作槽、跟随 tick、时间与取消原语            | 模型决策                         |
| `agent/prompt/`  | 系统提示词、技能指引、模型视图                                       | 工具执行                         |
| `agent/model/`   | 模型端口、Pi/Ollama 适配、请求计量与超时                             | 工具执行、任务状态转换           |
| `persistence/`   | 存档序列化与版本迁移                                                 | 运行时决策、世界访问             |
| `testing/`       | 确定性夹具，供包内单测和 CLI 使用                                    | 生产代码依赖                     |

## 依赖方向

```mermaid
flowchart TD
  api[api] --> agent[agent]
  api --> world[world]
  api --> persistence[persistence]
  agent --> world
  agent --> contracts[contracts]
  world --> contracts
  persistence --> contracts
```

箭头表示允许的 import 方向，反向一律禁止。具体约束：

| 层            | 可以依赖                                   | 明确禁止                                     |
| ------------- | ------------------------------------------ | -------------------------------------------- |
| `contracts`   | `@voxel/shared` 的纯类型                   | 任何实现、`node:*`、Pi / Colyseus 类型       |
| `kernel`      | 无                                         | 其他层、业务类型                             |
| `world`       | `contracts`、`kernel`、shared              | `agent/*`、`api`、Pi SDK                     |
| `agent/task`  | `contracts`、`kernel`                      | 世界执行、Pi、`node:crypto`                  |
| `agent/model` | `contracts`、`kernel`、`@earendil-works/*` | `agent/turn`、`api`                          |
| `agent/tools` | `contracts`、`prompt`、`tools/port.ts`     | `turn` 实现、`api`                           |
| `agent/turn`  | `agent/*`、`world/observe`、`contracts`    | 直接调用 `world/actions/execute`（走执行器） |
| `persistence` | `contracts`                                | `world`、`agent`、`api`                      |
| `api`         | 全部（唯一组装点）                         | —                                            |

`index.ts` 只导出 `api/`；包内模块用相对路径，不通过入口回绕。服务端与 CLI 不深层导入包实现。

## 执行路径

1. **接入**：`api/runtime.ts` 注入 `RuntimePorts`，保证一个角色只有一个执行槽，重复唤醒直接拒绝。
2. **归一**：`api/intake.ts` 把聊天、控制、计划到期、动作完成统一成 `CharacterEvent`。去重 id 只在这里生成，鉴权只走 `agent/task/policy`，先落盘再入队；队列满时标记 `unknown` 而不是丢弃后重试。
3. **唤醒**：`agent/turn/wake.ts` 取事件；有已保存的跟随意图且无新消息时推进一次本地跟随；后台动作未结束时等它结束或等新消息，不并发发起第二次决策。
4. **决策**：`agent/turn/turn.ts` 按 `attach → prepare → decide → settle` 推进。`prepare.ts` 观察世界并交给 `reconcile.ts` 核对未确认效果，`input.ts` 构造模型输入，`decide.ts` 装配 Pi Agent，`guards.ts` 在工具边界拦截截断、已停止、预算耗尽和失败批次。
5. **工具**：`agent/tools/*` 的 schema 是模型契约，handler 只依赖 `ToolHost`（定义在 `tools/port.ts`，由 `Turn` 实现：prepared/observe/save/attach/respond/commitTask/launch）。工具只转发意图，不直接改 host 配置或 lease；任务命令走 `policy` 与 `lease`，配置切换与记账由 `Turn.commitTask` 统一完成，世界动作交给执行器。
6. **动作**：`agent/action/executor.ts` 在每次执行前校验 lease，同步动作在 turn 内完成；`goto`/`build`/`house` 进入 `background.ts`，结束后投递 `action_result` 事件回到接入层；`follow` 由宿主 tick 经 `follow.ts` 推进，不请求模型。
7. **收尾**：任务进入结束态后清空可重放状态，`snapshot()` 提供只读投影，`store` 原子保存。宿主只持久化投影，不解析内部字段。

headless 场景由 `agent/schedule.ts` 驱动：语义与宿主完全一致，只额外负责等待下一次唤醒。CLI 不直接调用 `turn`，也不另建第二套任务入口。

## 公共入口

```ts
import { createAgentRuntime } from '@voxel/agent-runtime';

const runtime = createAgentRuntime({ session, model, store, clock, log });
await runtime.start({ character, model, limits });
runtime.submit(worldEvent); // 聊天、控制、计划、动作结果都走这里
await runtime.control({ type: 'pause', by: 'operator' });
const state = runtime.snapshot(); // 只读投影，用于存档与控制台
await runtime.stop();
```

- 宿主不得拼事件 id、不得解析控制指令、不得改动 `AgentState` 字段；需要新输入时只调用 `submit`。
- 包内测试与 CLI 夹具使用 `@voxel/agent-runtime/testing`，不复制生产实现。
- 构建与类型检查依赖包内 `tsconfig.json`；`exports` 只保留 `.` 和 `./testing` 两个入口。

## 状态与存档

`AgentState` 为 v3，按 owner 分区，每个分区只有一个模块写入：

| 分区           | 内容                                                      | owner          |
| -------------- | --------------------------------------------------------- | -------------- |
| `task`         | 当前任务、租约身份、累计用量                              | `agent/task`   |
| `conversation` | 公共与各私聊会话最近 8 组完整交互，最多追踪 16 个私聊对象 | `agent/turn`   |
| `checkpoint`   | Pi 转录检查点、未确认动作                                 | `agent/turn`   |
| `effects`      | 最近批次、未完成建造、跟随意图、后台动作                  | `agent/action` |
| `inbox`        | 待处理事件与最近 64 条审计记录                            | `api/intake`   |

`persistence/migrate.ts` 的 `restoreState(raw)` 是唯一读取旧档的入口（idempotent，未知输入降级为空分区），`emptyState()` 构造完整 v3 分区，`snapshotState()` 生成不含 `usage` 的历史运行快照。分区是原地写入的同一对象：现有调用方持有的 `memory` 引用在任务重置后仍然有效。

规则：

- 启动时执行中的任务转为暂停，执行中的动作标记 `unknown`，**不重放**未知效果的聊天或移动。
- 检查点与事件队列随宿主存档持久化；旧档升级前生成 `.before-character-events-v3.bak` 备份。
- 预算只统计真实模型请求：一次事件使用独立额度，附着任务后切换到任务额度；这是取值，不是原地修改配置对象。排队不创建运行时任务，也不计费。
- 默认上限：单任务 100 次调用、50,000 tokens、900,000 ms；连续 3 次失败或无进展即停止自动重试。角色可在控制台调整。

## 模型与工具边界

- `prompt/` 是面向模型的产品文本；`tools/schema.ts` 是模型契约；`tools/*` 的 handler 是策略执行点。三者分开演进。
- 模型输出永远是数据：进入执行前由 `world/actions/parse.ts` 再校验一次，权限来自 shared 的 `aiCharacterPermissions`，与工具 schema 形成双重防线。
- 除 `agent/model` 和 `agent/turn/decide.ts` 外，包内不出现 Pi SDK 类型；`persistence` 把转录当不透明 JSON（`PiCheckpoint.messages: unknown[]`）。
- 自由文本不进入动作通道；回复、任务状态和世界动作必须走各自工具。

## 时间、取消与预算

- `kernel/abort.ts` 是唯一的超时与取消组合实现，对外提供 `withDeadline(parent, ms)`、`mergeSignals(...)` 与 `cancellable`；禁止再写内联副本或直接用 `AbortSignal.any`。
- 时间、id、随机数通过 `ports` 注入；业务代码不直接调用 `Date.now()`、`crypto.randomUUID()` 或 `Math.random()`。
- `agent/task/budget.ts` 只做计算与记账；请求边界上的计时、token 结算和脱敏在 `agent/model/stream.ts`。

## 测试与验证

包内测试覆盖纯规则与状态机：任务命令与租约、预算、动作解析与建造规划、转录裁剪、事件去重、turn 状态迁移、存档往返与旧档迁移。测试夹具在 `testing/`，不依赖真实网络和真实模型。

`packages/agent-runtime/test/boundaries.test.ts` 检查依赖方向与循环依赖，`packages/agent-runtime/test/pi-runner.test.ts` 通过真实 Pi 循环与可控模型响应检查预算、取消、工具顺序、隔离和检查点恢复。`tests/support/decision-*` 是旧业务用例的确定性适配器，不是生产执行路径。

在仓库根目录运行：

```sh
pnpm check
pnpm test:agents
pnpm test:agent:tasks
pnpm test:chat
pnpm test:agent:voice
pnpm test:voice:services
pnpm test:agent:deepseek   # Pi 工具与世界连接
```

模型及语音集成使用 fixtures，不能替代真实服务验证；`apps/server/test/task-service.test.ts` 覆盖修订、保存失败和旧存档迁移。

CLI 多客户端回归 `pnpm test:integration` 会连接 `SERVER_URL` 指向的现有世界并编辑固定坐标，且要求 PostgreSQL 持久化。必须先准备独立测试世界，再显式设置地址，例如 `SERVER_URL=ws://127.0.0.1:12567 pnpm test:integration`，不要直接对正在使用的世界运行。

Docker 验证需单独构建服务端，在隔离实例或短暂停机备份后验证真实模型任务、重启恢复及旧存档兼容。不要用 `down -v` 清空现有数据卷。

## 导航

`world/nav/map.ts` 管理已知空间，`astar.ts` 搜索可站立节点，`controller.ts` 执行可取消的位置闭环。跳跃/下落边通过共享 `simulate()` 验证；普通平移检查体积与中间路径。搜索每约 2ms 让出事件循环，并限制扩展节点数量。局部无路不表示全局不可达。

`agent/action/follow.ts` 在宿主唤醒时推进已保存的跟随意图，不发起模型请求。新消息仍走正常任务归属流程；暂停/取消中止动作，失败时停止，不重放历史方向输入。

验证：`pnpm test:navigation` 启动临时端口的独立内存世界，覆盖真实 WebSocket 和服务端物理；`pnpm bench:navigation` 报告本机地图构建及搜索耗时。`packages/agent-runtime/src/world/nav/{map,astar,controller}.test.ts` 覆盖确定性物理、动态障碍、未知空间和取消；`packages/agent-runtime/test/navigation.test.ts` 覆盖 Pi 到跟随调度的跨模块链路。

真实模型验收：`NAVIGATION_PROVIDERS=/absolute/path/providers.json pnpm test:navigation:live`。显式读取已有服务配置并产生真实模型费用，在隔离的 Colyseus 世界向托管角色私聊“到我这里来”，断言任务创建、绕墙/上台阶、实际到达和持久化完成；每场景至多 8 次请求；另验收持续跟随期间不请求模型、普通问答保留任务及独立计费、修改目标后实际到达。默认使用 `deepseek` 服务，可用 `NAVIGATION_PROVIDER` 选择其他已配置服务。结果写入忽略目录 `artifacts/navigation-live-model.json`，不输出凭据。详细规则见 [统一运行时](../../docs/agent/runtime.md)。

## 附录：旧路径对照

| 旧路径                                                     | 新路径                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `runtime/agent-runner.ts`                                  | `api/runtime.ts` + `agent/schedule.ts`                        |
| `runtime/character-runner.ts`                              | `agent/turn/wake.ts` + `agent/turn/turn.ts`                   |
| `runtime/decision-loop.ts`                                 | `agent/turn/decide.ts` + `guards.ts`                          |
| `runtime/{world-tools,task-control-tools}.ts`              | `agent/tools/{world,conversation,task}.ts`                    |
| `runtime/{task-executor,background-action,follow-step}.ts` | `agent/action/{executor,background,follow}.ts`                |
| `perception/observation.ts`                                | `world/observe/{extract,verify}.ts` + `agent/turn/prepare.ts` |
| `perception/{attention,chat-context}.ts`                   | `world/observe/{attention,scope}.ts` + `api/intake.ts`        |
| `runtime/{decision-payload,options,turn-context}.ts`       | `agent/turn/{input,options,turn}.ts`                          |
| `cognition/{prompts,skill-guidance}.ts`                    | `agent/prompt/{system,skills}.ts`                             |
| `cognition/{context,checkpoint,tool-schemas}.ts`           | `agent/turn/{window,checkpoint}.ts`、`agent/tools/schema.ts`  |
| `models/*`                                                 | `agent/model/*`                                               |
| `transport/session.ts`、`transport/cancellable.ts`         | `world/session/colyseus.ts`、`kernel/abort.ts`                |
| `task/*`                                                   | `contracts/state.ts` + `agent/task/*` + `persistence/*`       |
| `actions/*`、`actions/navigation/*`                        | `world/actions/*`、`world/nav/*`                              |
| `contracts.ts`、`errors.ts`                                | `contracts/*`                                                 |

迁移顺序：先做无行为变化的搬迁与出口收敛，再统一时间/取消原语与接入层，最后处理 `AgentState` 分区与 `Turn` 对象化。每一步都保持 `pnpm check` 与既有集成测试通过。
