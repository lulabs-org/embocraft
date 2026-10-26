# @voxel/shared

`@voxel/shared` 存放服务端、Web 客户端和 Agent 运行时共用的 TypeScript 契约与计算规则，包括世界协议、物理与几何、AI 角色和任务数据、语音配置以及聊天事件。

## 导入

包的根入口导出 `world`、`agent`、`task`、`audio` 和 `communication`；也可以按领域导入。管理网关使用独立入口 `@voxel/shared/management`，**不**从根入口导出。

```ts
import { inBounds, type Vec3 } from '@voxel/shared';
import { simulate } from '@voxel/shared/world';
import type { AICharacterTask } from '@voxel/shared/task';
import { ManagementEvents } from '@voxel/shared/management';
```

## 目录

| 目录                 | 主要内容                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `src/world/`         | 世界快照、玩家和事件类型；坐标、边界、碰撞、物理模拟与导航所需的地图契约 |
| `src/agent/`         | AI 角色设置与视图、技能与权限、模型服务配置                              |
| `src/task/`          | 角色任务、计划与执行记录、默认限额、时区和墙上时间换算                   |
| `src/audio/`         | ASR 与语音服务配置、空间音频计算                                         |
| `src/communication/` | 聊天路由、消息和实时事件类型                                             |
| `src/management/`    | 管理网关的请求与事件契约，以及事件订阅客户端                             |

新增跨包数据结构或确定性规则时，放在对应领域，并通过该目录的 `index.ts` 导出。只有需要供根入口使用的领域才由 `src/index.ts` 重新导出。服务端持久化、HTTP 路由和 Agent 决策实现应保留在各自的包中。

## 验证

在仓库根目录运行：

```sh
pnpm --filter @voxel/shared build
pnpm --filter @voxel/shared lint
```

修改跨包契约后，再运行 `pnpm check` 验证所有使用方。
