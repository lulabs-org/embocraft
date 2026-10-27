# 详细架构图

本文用一组 Mermaid 图从多个层级描述 EmboCraft 的架构：部署拓扑 → Monorepo 依赖 → 服务端装配 → 网络入口 → 前端分层 → Agent 运行时 → 关键时序 → 持久化。文字说明见 [项目架构与代码组织](./architecture.md)。

---

## 1. 系统全景与部署拓扑

对应 `docker-compose.yml`：`web`（Nginx 托管静态资源并反代）、`server`（Node 单进程）、`speech`（Whisper/Piper 语音服务）、`db`（PostgreSQL 17）。

```mermaid
graph LR
    subgraph Users["用户侧"]
        Browser["浏览器<br/>React 19 + Three.js"]
        CLI["CLI / 脚本<br/>scripts/agent/agent-control.ts"]
    end

    subgraph Docker["docker compose"]
        Web["web 容器<br/>Nginx :80<br/>apps/web 构建产物"]
        Server["server 容器 :2567<br/>Express + Colyseus 0.16<br/>+ AI 角色运行时"]
        Speech["speech 容器 :8000<br/>Whisper ASR / Piper TTS<br/>OpenAI 兼容 /v1"]
        DB[("db 容器<br/>PostgreSQL 17")]
        Vol[("server_data 卷<br/>/app/.data")]
    end

    subgraph External["外部模型服务"]
        DeepSeek["DeepSeek / OpenAI 兼容 API"]
        Ollama["Ollama（本地/局域网）"]
        Bailian["阿里云百炼<br/>实时语音 / ASR"]
    end

    Browser -->|HTTP / WS| Web
    Web -->|反向代理| Server
    CLI -->|WS Gateway + HTTP| Server
    Server -->|Prisma + pg| DB
    Server -->|JSON 文件| Vol
    Server -->|ASR / TTS| Speech
    Server -->|LLM 推理| DeepSeek
    Server -->|LLM 推理| Ollama
    Server -->|实时会话| Bailian
    Browser -.->|浏览器 ASR / TTS / WebRTC| Browser
```

---

## 2. Monorepo 包依赖

```mermaid
graph TD
    Web["@voxel/web<br/>apps/web"]
    ServerPkg["@voxel/server<br/>apps/server"]
    Runtime["@voxel/agent-runtime<br/>packages/agent-runtime"]
    Shared["@voxel/shared<br/>packages/shared（零依赖）"]
    Docs["@voxel/docs<br/>docs（VitePress）"]
    Scripts["scripts/agent<br/>tests/benchmarks"]

    Web --> Shared
    ServerPkg --> Runtime
    ServerPkg --> Shared
    Runtime --> Shared
    Scripts --> Runtime
    Scripts --> Shared

    Web -.->|colyseus.js / three / i18next / radix-ui| WebLibs(("第三方"))
    ServerPkg -.->|@colyseus/core / express / prisma / ws / swagger| SrvLibs(("第三方"))
    Runtime -.->|pi-agent-core / pi-ai / openai / colyseus.js| RtLibs(("第三方"))
```

`@voxel/shared` 内部按领域拆分子模块：

```mermaid
graph LR
    Shared["@voxel/shared"] --> World["world<br/>core · geometry · physics · navigation"]
    Shared --> Agent["agent<br/>capabilities · characters"]
    Shared --> Task["task<br/>contracts · plans · timing"]
    Shared --> Comm["communication<br/>chat · realtime"]
    Shared --> Audio["audio<br/>asr · spatial · voice-services"]
    Shared --> Mgmt["management<br/>client · contracts"]
```

---

## 3. 服务端装配（`apps/server/src/server.ts`）

`createServer()` 是唯一的组合根：加载存储 → 构建领域服务 → 组装 HTTP 与 Socket 路由 → 定义 Colyseus 房间。

```mermaid
graph TD
    Index["index.ts<br/>读取 env · 启动/停止"] --> Create["createServer()"]

    Create --> Startup["startup.ts<br/>checkStartupDatabase"]
    Create --> Stores["loadStores()（并行）"]
    Stores --> GA["GatewayAuth<br/>gateway/auth.service"]
    Stores --> PS["FileProviderRepository<br/>providers"]
    Stores --> VS["VoiceServiceStore<br/>audio/tts"]
    Stores --> AS["AsrSettingsStore<br/>audio/asr"]

    Create --> VP["createVoiceProvider<br/>audio/session（mock/browser/ollama）"]
    Create --> WS["WorldStore<br/>world/persistence/store（Prisma）"]
    Create --> ACM["AICharacterManager<br/>ai-characters"]
    Create --> MC["ModelCatalog<br/>providers/model-catalog"]
    Create --> LS["LocalSpeech<br/>audio/asr"]

    Create --> App["createApp()<br/>app.ts（Express）"]
    Create --> Sockets["SocketRoutes Map"]
    Sockets --> GWS["installGatewaySocket<br/>/ai-characters/gateway"]
    Sockets --> ASRS["installAsrSocket<br/>/voice/asr/realtime"]

    Create --> Transport["RoutedWebSocketTransport<br/>按路径分发 WS 升级"]
    Transport --> Colyseus["Colyseus Server"]
    Colyseus --> Room["define('world', WorldRoom)"]

    ACM -.->|tasks| Tasks["tasks 模块"]
    ACM -.->|events| Events["management/services/events.service"]
    PS --> ACM
    VS --> ACM
    PS --> MC
```

### 服务端模块全景

```mermaid
graph TB
    subgraph Entry["接入层"]
        HTTP["http/<br/>cors · origin-guard · error-handler<br/>health · docs · management"]
        TR["transport/<br/>websocket.transport · socket-routes"]
        OA["openapi/<br/>swagger · schemas"]
    end

    subgraph Modules["modules/ 领域模块"]
        World["world<br/>world.room · world.schema<br/>domain · persistence · routes"]
        AIC["ai-characters<br/>domain · services<br/>persistence · routes"]
        Tasks["tasks<br/>domain · services（scheduler/coordinator/execution）<br/>persistence · routes · ports"]
        Mgmt["management<br/>services（command-router · commands · events · public-error）<br/>routes"]
        GW["gateway<br/>auth.service · gateway.socket · validation"]
        Prov["providers<br/>store · catalog · validation · routes"]
        Chat["chat<br/>domain（visibility） · services<br/>routes（chats.routes）"]
        Audio["audio<br/>asr · tts · session · spatial · processing"]
        RT["realtime<br/>domain（limits）<br/>services（hub · session · scene-tools）<br/>adapters（demo-socket）"]
    end

    subgraph Infra["基础设施"]
        Common["common/<br/>validation · errors · command-queue · origin-policy"]
        Config["config/<br/>env"]
        Persist["persistence/<br/>archive · management-persistence"]
    end

    HTTP --> Mgmt
    HTTP --> Prov
    HTTP --> Chat
    HTTP --> Audio
    HTTP --> World
    TR --> GW
    TR --> Audio
    TR --> World

    GW --> Mgmt
    Mgmt --> AIC
    Mgmt --> Tasks
    AIC --> Tasks
    AIC --> Prov
    AIC --> Audio
    World --> Chat
    World --> Audio
    World --> RT
    AIC --> Persist
    Tasks --> Persist
    Modules --> Common
    Modules --> Config
```

### AI 角色模块内部（`modules/ai-characters`）

```mermaid
graph LR
    Routes["routes/ai-characters.routes.ts<br/>REST 管理接口"] --> Orch["services/orchestrator.service.ts<br/>AICharacterOrchestrator"]
    Manager["services/character.manager.ts<br/>AICharacterManager"] --> Orch
    Orch --> Host["services/character-host.service.ts<br/>单角色生命周期"]
    Orch --> Voice["services/voice-coordinator.service.ts"]
    Orch --> Restore["persistence/restore · snapshots"]
    Host --> Ctx["services/execution-context.ts"]
    Orch --> Wake["services/wake-scheduler.service.ts"]
    Host --> WEH["services/world-event-handler.ts"]
    Host --> Log["domain/activity-log"]
    Host --> TA["services/task-adapter.ts"]
    Ctx -->|Session / AgentRunner| RTPkg["@voxel/agent-runtime"]
    WEH -->|recordEvent / TaskService| RTPkg
    TA --> TaskMod["modules/tasks"]
```

---

## 4. 网络入口与协议

单个 HTTP 端口（默认 `2567`）同时承载 REST、SSE 与多路 WebSocket。

```mermaid
graph LR
    subgraph Clients["客户端"]
        WebC["Web 前端<br/>network/connection.ts"]
        WebG["Web 控制台<br/>network/gateway.ts"]
        WebP["Web 大厅<br/>network/world-presence.ts"]
        WebA["Web 语音<br/>audio/services"]
        AgentC["AI 角色 Session<br/>（进程内，colyseus.js）"]
        CLIc["CLI agent:ctl"]
    end

    subgraph Port["HTTP Server :2567"]
        direction TB
        REST["Express REST<br/>/ai-characters · /tasks · /task-runs · /providers<br/>/management · /world · /chat · /voice/*<br/>/health · /api-docs"]
        SSE["SSE<br/>/world/presence"]
        Upg{"WS Upgrade<br/>RoutedWebSocketTransport"}
        GWWS["/ai-characters/gateway<br/>管理事件 + 命令"]
        ASRWS["/voice/asr/realtime<br/>流式识别"]
        COL["Colyseus 房间 'world'<br/>sync · action · state patch"]
    end

    WebC --> COL
    AgentC --> COL
    WebG --> GWWS
    CLIc --> GWWS
    CLIc --> REST
    WebG --> REST
    WebP --> SSE
    WebA --> ASRWS
    WebA --> REST

    Upg --> GWWS
    Upg --> ASRWS
    Upg -->|其余路径| COL
```

`WorldRoom` 的 `action` 消息按 `type` 分发：

```mermaid
graph TD
    Action["onMessage('action')<br/>{ id, type, payload }"] --> Allow{"allow() 限流/鉴权<br/>信封校验"}
    Allow --> Move["move → 物理输入"]
    Allow --> Edit["edit → 方块 CAS 写入 → WorldStore"]
    Allow --> Rename["rename"]
    Allow --> AV["agent.voice → 角色语音开关"]
    Allow --> VoiceS["voice.* → VoiceProvider 会话"]
    Allow --> Spatial["spatial.signal → WebRTC 信令"]
    Allow --> Realtime["realtime.* → RealtimeHub<br/>realtime.approve → edit"]
    Allow --> ChatM["chat → Chat 模块"]
    Sync["onMessage('sync')"] --> Snap["snapshot() 全量快照"]
```

---

## 5. 前端分层（`apps/web/src`）

```mermaid
graph TB
    Main["main.tsx"] --> App["App.tsx<br/>Lobby ↔ Game 状态切换"]
    App --> Layout["components/layout<br/>LobbyLayout · GameHUDLayout"]

    subgraph Features["features/（业务特性）"]
        FWorld["world<br/>LobbyCard · WorldPanel<br/>useWorldSession · useWorldScene"]
        FHud["hud<br/>GameHeader · GameMenu · GameFooter<br/>useHudController · useGameShortcuts"]
        FChat["chat<br/>ChatPanel · MentionPicker · VoiceDraft<br/>useChatController"]
        FVoice["voice<br/>SpatialVoicePanel · SpeechCaption<br/>SpeechRecognitionPanel"]
        FConsole["console<br/>ControlConsole · GatewayAccess<br/>ai-characters · tasks · providers · voice · execution"]
    end

    subgraph Infra["基础层"]
        Graphics["graphics<br/>scene · entities/avatar · controls/pointer-lock"]
        AudioL["audio<br/>core · recording · services · spatial"]
        Net["network<br/>connection · gateway · endpoints · world-presence"]
        UI["components/ui<br/>Button · Dialog · LanguageSwitcher"]
        I18n["i18n<br/>config · context · locales"]
    end

    Layout --> Features
    FWorld --> Graphics
    FWorld --> Net
    FHud --> Graphics
    FChat --> Net
    FChat --> AudioL
    FVoice --> AudioL
    FConsole --> Net
    Features --> UI
    Features --> I18n
    Net --> SharedW["@voxel/shared"]
    Graphics --> SharedW
```

---

## 6. Agent 运行时（`packages/agent-runtime`）

感知 → 认知 → 决策 → 行动 的分层，任务与预算贯穿其中。

```mermaid
graph TB
    subgraph Transport["transport"]
        Session["Session<br/>colyseus.js 客户端<br/>observe / act"]
        Cancel["cancellable"]
    end

    subgraph Perception["perception"]
        Obs["observation<br/>prepareDecision · worldSignature"]
        Att["attention"]
        ChatCtx["chat-context"]
    end

    subgraph Cognition["cognition"]
        Prompts["prompts · skill-guidance"]
        Ctx["context · checkpoint"]
        Tools["tools · tool-schemas"]
    end

    subgraph Runtime["runtime"]
        AR["AgentRunner"]
        CR["character-runner<br/>单轮编排"]
        DL["decision-loop<br/>pi-agent-core Agent"]
        DP["decision-payload · turn-context"]
        WT["world-tools · task-control-tools"]
        BG["background-action"]
        Misc["chat-pacing · follow-step<br/>turn-health · scheduled-loop"]
    end

    subgraph Actions["actions"]
        Parse["parse"]
        Exec["execute · batch"]
        Build["building"]
        Nav["navigation<br/>controller · local-map · voxel-astar"]
    end

    subgraph Task["task"]
        TS["TaskService · state"]
        Inbox["inbox（recordEvent）"]
        Budget["RequestBudget"]
    end

    subgraph Models["models"]
        Adapter["provider-adapter<br/>pi-ai"]
        Catalog["catalog · ollama"]
    end

    AR --> CR
    CR --> Obs
    CR --> DP
    CR --> DL
    CR --> WT
    CR --> BG
    CR --> Misc
    CR --> TS
    CR --> Budget
    DP --> Prompts
    DP --> Ctx
    DL --> Adapter
    DL --> Tools
    WT --> Exec
    Exec --> Parse
    Exec --> Build
    Exec --> Nav
    Exec --> Session
    Obs --> Session
    Obs --> Att
    Obs --> ChatCtx
    Inbox --> TS
    Adapter --> LLM(("LLM Provider"))
```

---

## 7. 关键时序

### 7.1 AI 角色一次决策轮次

```mermaid
sequenceDiagram
    autonumber
    participant Room as WorldRoom
    participant Host as CharacterHost
    participant Runner as AgentRunner / character-runner
    participant Loop as decision-loop (pi-agent-core)
    participant LLM as LLM Provider
    participant Tools as world-tools / actions
    participant Task as TaskService

    Room-->>Host: 世界事件（聊天 @、方块变化、玩家靠近）
    Host->>Task: recordEvent → inbox
    Host->>Host: wake-scheduler 唤醒
    Host->>Runner: run(turn)
    Runner->>Room: Session.observe()（快照 / 局部地图）
    Runner->>Runner: prepareDecision + buildDecisionPayload
    Runner->>Loop: runDecisionLoop(prompt, tools, budget)
    loop 工具调用轮次（受 RequestBudget 限制）
        Loop->>LLM: chat completion（stream）
        LLM-->>Loop: tool_call
        Loop->>Tools: move / navigate / build / say ...
        Tools->>Room: action 消息
        Room-->>Tools: reply + state patch
        Tools-->>Loop: ActionResult
    end
    Loop-->>Runner: 结果 / checkpoint
    Runner->>Task: 更新任务状态
    Runner-->>Host: 轮次完成
    Host-->>Host: activity-log + management events → Gateway 推送控制台
```

### 7.2 玩家放置方块

```mermaid
sequenceDiagram
    autonumber
    participant UI as Web (Three.js)
    participant Conn as network/connection
    participant Room as WorldRoom
    participant Store as WorldStore (Prisma)
    participant DB as PostgreSQL
    participant Others as 其他客户端 / AI 角色

    UI->>Conn: 点击放置
    Conn->>Room: action {type: edit, payload}
    Room->>Room: 校验（范围 / 权限 / 碰撞）
    Room->>Store: CAS 写入（revision）
    Store->>DB: INSERT BlockEdit / UPDATE World
    DB-->>Store: ok
    Store-->>Room: 新 revision
    Room-->>Conn: reply {ok}
    Room-->>Others: state patch（50ms 频率）+ WorldEvent
```

### 7.3 控制台管理命令

```mermaid
sequenceDiagram
    autonumber
    participant Console as Web 控制台 / CLI
    participant GW as /ai-characters/gateway
    participant Auth as GatewayAuth
    participant Router as management/services/command-router.service
    participant ACM as AICharacterManager
    participant Tasks as tasks 模块

    Console->>GW: WS 连接（token）
    GW->>Auth: 校验令牌 + Origin
    Console->>GW: command（创建角色 / 下发任务）
    GW->>Router: 分发
    Router->>ACM: create / update / join / leave
    Router->>Tasks: schedule / cancel
    ACM-->>GW: management events
    GW-->>Console: 实时事件推送
```

---

## 8. 持久化与数据流

```mermaid
graph LR
    subgraph PG["PostgreSQL（Prisma）"]
        WorldT["World<br/>revision"]
        EditT["BlockEdit<br/>增量方块编辑"]
        Prov["模型供应商配置"]
        Chars["AI 角色快照 · 活动日志"]
        TaskF["任务计划 · 执行快照"]
        VoiceF["TTS 服务配置"]
        ASRF["ASR 服务配置"]
    end

    subgraph Files[".data/ JSON 文件"]
        Token["gateway token"]
        Rec["聊天录音 / 语音缓存"]
    end

    subgraph Memory["内存（不持久化）"]
        Players["玩家位置 / 物理体"]
        EvBuf["事件环形缓存"]
    end

    WorldStoreN["WorldStore"] --> WorldT
    WorldStoreN --> EditT
    DatabaseProviderRepoN["DatabaseProviderRepository"] --> Prov
    VSN["VoiceServiceStore"] --> VoiceF
    ASN["AsrSettingsStore"] --> ASRF
    GAN["GatewayAuth"] --> Token
    MP["management-persistence / archive"] --> Chars
    MP --> TaskF
    ChatN["chat / agent-speech"] --> Rec
    RoomN["WorldRoom"] --> Players
    RoomN --> EvBuf
```

> 服务需要 PostgreSQL。模型供应商、Agent 与 TTS/ASR 服务配置保存在数据库；网关令牌及本地语音模型文件仍保存在 `server_data` 卷（容器内 `/app/.data`）。旧语音配置文件不会自动导入。
