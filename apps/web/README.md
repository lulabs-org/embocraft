# Web 架构与验证

`src/App.tsx` 负责连接各 feature 的状态与布局，`main.tsx` 创建共享连接并挂载 React。页面交互、网络协议和音频能力分别由自己的模块管理。

```text
src/
├── components/
│   ├── ui/                   # 原生 Button、Dialog；模态焦点与关闭生命周期
│   └── layout/               # GameHUDLayout、LobbyLayout 与通用布局样式
├── hooks/                    # useViewportAdjust：视口和虚拟键盘偏移
├── audio/
│   ├── core/                 # PCM 采集/播放、Worklet、时间轴
│   ├── recording/            # 短录音、实时录音、本地录音会话
│   ├── spatial/              # 空间语音、转写、Agent 语音播放
│   ├── services/             # 浏览器、百炼及 HTTP 语音适配
│   └── index.ts              # 现有能力的公共入口
├── graphics/
│   ├── scene.ts              # Three.js 场景与渲染循环
│   ├── entities/             # Avatar 与 AI 角色实体
│   └── controls/             # 指针锁与 DOM 输入目标识别
├── network/                  # 世界连接、presence、统一地址解析
├── features/
│   ├── chat/                 # 组件、controller、聊天 API
│   ├── console/
│   │   ├── characters/        # AI 角色列表、编辑、轮询、API、展示逻辑
│   │   ├── tasks/            # 任务编辑、执行记录、API、展示逻辑
│   │   ├── providers/        # 模型服务编辑、模型查询与取消、API
│   │   ├── voice/            # TTS 服务、预览与配置 API
│   │   ├── request.ts        # 控制台 HTTP 传输与错误解码
│   │   ├── useConsoleFeedback.ts # 共享提示与互斥修改/轮询版本保护
│   │   └── useConsoleController.ts # 分类、滚动和子域协调
│   ├── hud/                  # HUD、菜单、快捷键与面板互斥
│   ├── voice/                # 空间语音与 ASR 配置/试用 UI
│   └── world/                # 大厅、玩家列表、场景与入退世界生命周期
└── styles/                   # tokens、reset、按既有顺序加载各域样式
```

## 依赖规则

- App 和跨 feature 调用通过各域的 `index.ts`；域内部直接引用具体模块，不绕回自身入口。
- `components`、`hooks`、`audio`、`graphics`、`network` 不依赖 features。音频、图形和网络模块不依赖 React。
- 组件和业务 hooks 不直接调用 `fetch`，HTTP 请求由对应 `api.ts` 管理；控制台子域共享 `request.ts`。所有服务地址由 `network/endpoints.ts` 解析。
- `audio/index.ts` 导出现有录音和播放会话，不创建全局 AudioContext 或改变资源所有权。实时录音采集引用 `core/pcm-worklet.js`。
- `Dialog` 只管理原生模态框和焦点恢复。关闭控制台不会卸载其子树；TTS/ASR 切换使用 `hidden`，同时以 `active` 控制资源活动。
- Agent 修改仍通过共享互斥锁与 revision 防止旧轮询覆盖最新结果。关闭控制台取消读取和模型查询并停止轮询。
- 切换大厅/游戏时，布局组件保持同一个画布位置；退出世界仍显式执行场景、连接和通信面板清理。

## 样式顺序

`styles/main.css` 按原有顺序导入各 feature 的连续样式片段，避免在迁移时改变层叠。`main.tsx` 必须先导入该入口，最后导入 `features/hud/hud.css`；不能按字母顺序调整这两条副作用 import。设计变量使用原有颜色、圆角和层级值。

## 验证

在仓库根目录运行 `pnpm check`、`pnpm format:check`。`tests/web-boundaries.test.ts` 检查依赖方向、跨域入口、循环依赖、请求边界、Worklet 文件与样式加载顺序。

浏览器验收可使用隔离服务器（不启动数据库、不读取生产配置）：

```sh
pnpm --filter @voxel/server exec tsx test/sandbox/agent-console-sandbox.ts
VITE_SERVER_URL=ws://127.0.0.1:2589 pnpm --filter @voxel/web exec vite --host 127.0.0.1 --port 5189
```

检查大厅入退、控制台各分类、模型保存、角色和任务编辑、模态焦点、聊天与快捷键、窄屏面板互斥、短视口输入框，以及关闭后的轮询取消。沙箱模型是固定响应，不能作为真实模型导航证据。

真实模型验收使用已有的、包含凭据的 provider 文件；该命令会产生模型调用费用：

```sh
NAVIGATION_PROVIDERS=/absolute/path/to/providers.json pnpm test:navigation:live
```

测试断言私聊“到我这里来”创建任务、进入 running、执行 goto、移动到发送者并持久化完成记录，覆盖平地、绕墙和台阶。生产构建还需在浏览器核对 Worklet 加载。当前执行记录见 [验证记录](../../docs/changelog/validation.md)。
