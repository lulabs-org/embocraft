# ASR 语音识别模块 (Automatic Speech Recognition)

本模块负责服务器端语音识别（ASR）能力，包含识别服务配置持久化、音频转录（Batch Transcription）以及实时流式识别（Realtime Streaming）。

---

## 1. 核心职责与能力

| 能力             | 传输协议                          | 默认支持引擎                   | 核心场景                                                          |
| :--------------- | :-------------------------------- | :----------------------------- | :---------------------------------------------------------------- |
| **服务配置管理** | HTTP REST (`/voice/asr/*`)        | 全部 (Whisper, 百炼)           | 供应商配置 CRUD、API Key 脱敏、用途绑定 (`chat`/`spatial`/`clip`) |
| **音频文件转录** | HTTP POST (`/voice/transcribe`)   | Speaches / OpenAI 兼容 Whisper | 录音片段上传、短语音/长音频批量转文字、并发排队调度               |
| **实时流式识别** | WebSocket (`/voice/asr/realtime`) | 阿里云百炼 (DashScope)         | 浏览器实时麦克风推流（PCM），低延迟双向推送 interim/final 文本    |

---

## 2. 现状结构与历史包袱说明

目前模块结构如下：

```text
apps/server/src/modules/asr/
├── domain/                       # 领域模型与纯校验规则
│   ├── model.ts                  # SavedService 实体、用途分配 (chat/spatial/clip) 与脱敏视图
│   ├── validation.ts             # 百炼/Whisper 参数校验与通用服务组装
│   └── validation.test.ts        # 纯业务逻辑单元测试
├── ports.ts                      # 模块端口契约 (BatchTranscriberPort, StreamingAsrPort 等)
├── engines/                      # 外部引擎适配器
│   ├── whisper/                  # Whisper 批处理适配器与模型目录探测
│   └── bailian/                  # 阿里云百炼实时流式识别适配器与端点管理
├── persistence/
│   ├── asr-settings-store.ts     # AsrSettingsStore：配置持久化、内存缓存、使用中租借锁 (acquire/release)
│   └── database-asr-services.ts  # DatabaseAsrServicePersistence：数据库加载与保存
├── services/
│   ├── speech-scheduler.service.ts # SpeechScheduler：针对 Whisper 的并发限制队列 (最大 4 并发)
│   └── transcript.ts             # Whisper JSON 响应解析
├── routes/
│   ├── asr.http.ts               # HTTP 中间件与路由挂载入口
│   ├── asr.routes.ts             # /voice/asr/* 配置管理与用途分配接口
│   ├── transcribe.routes.ts      # /voice/transcribe 文件音频转录
│   └── capabilities.routes.ts    # /voice/capabilities 能力探测接口
├── sockets/
│   └── asr.socket.ts             # /voice/asr/realtime 实时流识别握手与转发
└── index.ts                      # 模块外部导出出口
```

### 现存历史包袱与边界问题：

1. **命名历史包袱**：
   - `LocalSpeech`：实际是 Speaches / OpenAI 兼容 Whisper HTTP 客户端，支持本地与远程地址，并非仅本地。
   - `speech-scheduler.service.ts`：实际仅是 Whisper 批处理请求的限流排队器，并非全局语音调度器。
2. **职责聚合过多**：
   - `AsrSettingsStore` 兼具了数据库持久化、运行中租约锁控制（`acquire`/`release` 防止误删正在识别的配置）以及远程模型探测（`models()`）。
3. **跨域能力探针**：
   - `capabilities.routes.ts` 位于 ASR 模块，但同时查询并返回了 TTS 模块的 `PiperModels`。未来建议由顶层网关或组合层聚合返回。

---

## 3. 目标演进架构（轻量端口与适配器 Pragmatic Ports & Adapters）

为了更好地支持扩展新厂商（如火山引擎、Azure Speech、腾讯云等），模块推荐向与 `modules/providers` 一致的轻量端口-适配器架构演进：

```text
apps/server/src/modules/asr/
├── domain/                         # 领域模型与核心规则（零外部 I/O）
│   ├── model.ts                    # AsrService 实体定义、用途 (chat/spatial/clip)、脱敏视图
│   ├── validation.ts               # 集中化的各 Provider 配置规约校验
│   └── scheduler.ts                # 批处理并发排队规则
│
├── ports.ts                        # 模块接口契约 (Ports)
│   ├── AsrRepositoryPort           # 存储端口 (load, save, get)
│   ├── BatchTranscriberPort        # 批处理识别端口 (transcribe)
│   └── StreamingAsrPort            # 实时流识别端口 (bridge)
│
├── engines/                        # 外部引擎适配器 (Adapters / Engines)
│   ├── whisper/
│   │   ├── whisper.adapter.ts      # 实现 BatchTranscriberPort
│   │   └── whisper.models.ts       # 模型探测拉取
│   └── bailian/
│       ├── bailian.adapter.ts      # 实现 StreamingAsrPort
│       └── bailian.endpoint.ts     # 端点计算与鉴权
│
├── persistence/                    # 数据持久化
│   └── database-asr-services.ts    # 实现 AsrRepositoryPort
│
├── services/                       # 应用服务
│   ├── asr-management.service.ts   # 服务 CRUD、租约保护 (Lease Lock)、用途分配
│   └── asr-execution.service.ts    # 批处理排队调度与流式分配
│
├── routes/                         # HTTP 驱动适配器 (Express Routes)
│   ├── asr-management.routes.ts
│   └── transcribe.routes.ts
│
├── sockets/                        # WebSocket 驱动适配器
│   └── asr.socket.ts
│
└── index.ts                        # 模块公开外观
```

---

## 4. 接入新 ASR 引擎指引 (How-to: Add an Engine)

如需接入新的语音识别提供商（例如 Azure Speech、火山引擎或腾讯云）：

1. **确定能力类型**：
   - 若支持文件转录：提供对应的 HTTP 客户端，实现批量转录（`BatchTranscriber`）。
   - 若支持实时流识别：提供对应的 WebSocket/SDK 桥接，实现流式事件转发（`StreamingAsr`）。
2. **添加配置规约**：
   - 在 `services/{engine}-settings.ts`（或目标架构中的 `domain/validation.ts`）中定义参数校验规则。
   - 在 `@voxel/shared` 增加对应的 Draft / View 类型定义。
3. **在 Provider 列表中注册**：
   - 在 `validateService` 与 Store/Service 中挂载该 Provider 的分支。
   - 在前端管理界面添加该 Provider 的表单项配置。
