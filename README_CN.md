# EmboCraft

[English](README.md) | 简体中文

独立的本地多人 3D 体素与具身 AI 智能体运行沙盒：TypeScript · pnpm workspace · React/Vite · Three.js · Node/Colyseus · PostgreSQL/Prisma。

> [!TIP]
> 本项目配套了完整的在线开发与设计文档。更多深入架构、通信协议及 AI Agent 接入细节请参阅 [📚 文档中心](docs/index.md)（支持 `pnpm --filter docs dev` 本地预览）。

---

## 核心特性

- 🤖 **大模型 AI 玩家**：支持 DeepSeek 等大语言模型，具备自主观察、空间移动、多轮推理规划与方块编辑能力。
- 🎙️ **附近空间语音与实时转写**：内置 Whisper ASR 语音识别与 Piper 离线 TTS 语音合成，支持基于 3D 距离与朝向的衰减混音，并在断句后向附近玩家与 Agent 自动广播转写字幕。
- 🧱 **权威多人世界**：Three.js 实例化体素渲染，由 Node.js / Colyseus 服务端权威执行物理移动、速度、射线碰撞、重力及方块相邻支撑校验。
- 🔌 **Agent Gateway 管理中枢**：提供独立的 HTTP/WebSocket 协议端点，统一管理 AI 角色生命周期、任务计划队列、状态回执与 Token 预算保护。

---

## 快速运行

本地开发与 Docker Compose 共用 [.env.example](.env.example)。首次使用时复制为 `.env`，已有文件按需补充：

```sh
cp -n .env.example .env
```

按示例中的通用、本地开发、Docker Compose 分组配置。Docker 部署前设置数据库密码；详细默认值和覆盖方式见 [统一配置入口](docs/guide/getting-started.md#统一配置入口)。

### 1. 本地开发环境

环境要求：Node 22.13+、pnpm 10、PostgreSQL 17 二进制。无需云账号即可完整运行。

```sh
# 1. 安装依赖
pnpm install --frozen-lockfile

# 2. 准备数据库并启动迁移
pnpm db:generate
pnpm db:start      # 在本地端口 55432 启动独立 PostgreSQL
pnpm db:migrate    # 执行 Prisma 数据迁移

# 3. 启动前端与服务端开发环境
pnpm dev

# 4. 在另一个终端启动 AI 玩家（或无 AI 的测试机器人）
pnpm agent:ai --api-key sk-your-deepseek-api-key
# 无 AI 的测试机器人：pnpm agent:mock
```

启动后在浏览器中打开 http://127.0.0.1:5173，可用两个独立无痕窗口以不同昵称加入世界测试多人互动。

> 数据库内存回退、排错诊断及详细步骤请参阅 [快速开始指南](docs/guide/getting-started.md)。

### 2. Docker 一键全栈部署

本项目提供开箱即用的 Docker Compose 编排，包含 Web 前端、Node 后端、PostgreSQL 数据库以及内置的 Speaches 语音容器（Whisper ASR + Piper TTS）：

```sh
# 一键启动所有服务
pnpm docker:up
# 或：docker compose up -d --build

# 停止容器服务
pnpm docker:down
```

启动完成后：

- **Web 前端**：访问 `http://localhost`
- **Swagger API 文档**：访问 `http://localhost:2567/api-docs`

> 详细容器配置、旧版本升级与麦克风权限排查请参阅 [Docker 部署文档](docs/guide/getting-started.md#docker-全栈一键部署)。

---

## 游戏操作

| 动作         | 操作方式                                | 说明                                     |
| ------------ | --------------------------------------- | ---------------------------------------- |
| **视角控制** | 鼠标点击画面锁定，`Esc` 释放            | 鼠标指针控制朝向与仰角                   |
| **角色移动** | `W` / `A` / `S` / `D`                   | 前后左右移动                             |
| **跳跃**     | `Space`                                 | 垂直起跳（支持攀爬一格台阶）             |
| **方块编辑** | 准星对准 6 格内方块，左键破坏，右键放置 | 支持底部 UI 快捷放置/移除与材质选择      |
| **文字聊天** | 界面左下角聊天框                        | 支持群聊广播与 `@玩家昵称` 私聊          |
| **附近语音** | 语音控制面板                            | 支持麦克风发言、空间音效收听与语音转文字 |

---

## 仓库结构

项目采用 pnpm workspace 单体多包架构：

```text
embocraft/
├── apps/
│   ├── server/            # Colyseus 权威世界、HTTP 管理 API 与持久化存储
│   └── web/               # React 18 + Three.js 客户端、大厅与控制台 UI
├── packages/
│   ├── shared/            # 前后端共用的世界协议、物理计算与确定性地形
│   └── agent-runtime/     # CLI 与服务端共用的 Agent 决策与任务调度运行时
├── docs/                  # 基于 VitePress 的官方文档库
└── scripts/               # 本地数据库控制、Agent 管理 CLI 等运维脚本
```

更深入的领域架构分层、模块依赖契约与设计限制，请参阅 [项目架构与代码组织](docs/guide/architecture.md)。

---

## 文档索引

| 板块         | 文档                                          | 说明                                         |
| ------------ | --------------------------------------------- | -------------------------------------------- |
| **入门指南** | [快速开始](docs/guide/getting-started.md)     | 环境搭建、本地开发、Docker 部署与常见排错    |
| **系统架构** | [架构与代码组织](docs/guide/architecture.md)  | 前后端模块拆分、生命周期、限制与设计边界     |
| **协议规范** | [协议与扩展边界](docs/protocol/overview.md)   | 权威世界状态同步、输入校验与扩展约束         |
|              | [聊天与附近语音](docs/protocol/chat.md)       | 空间音频 WebRTC 信令、麦克风转写与广播流程   |
| **AI Agent** | [接入 AI 玩家](docs/agent/players.md)         | DeepSeek 模型接入、推理工具链与任务执行循环  |
|              | [Agent Gateway](docs/agent/gateway.md)        | 管理令牌、HTTP 控制端点与 WebSocket 状态订阅 |
|              | [统一事件运行时](docs/agent/runtime.md)       | 任务执行器、检查点持久化与预算配额保护       |
| **语音服务** | [语音服务管理](docs/voice/setup.md)           | Whisper ASR 与 Piper TTS 模型安装与配置      |
| **变更记录** | [验证记录](docs/changelog/validation.md)      | 浏览器双端回归、网络异常恢复与功能验收记录   |
|              | [Pi 架构迁移](docs/changelog/pi-migration.md) | Agent 运行时架构演进记录                     |

---

## 质量验证

```sh
pnpm check             # 全仓类型检查、ESLint、单元测试与构建
pnpm lint              # 源码规范检查
pnpm test:integration  # 多客户端世界协议集成测试
pnpm format:check      # 代码格式检查
```

---

## 开源协议

本项目基于 [MIT](LICENSE) 协议开源。
