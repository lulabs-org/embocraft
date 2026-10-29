# 语音服务管理与 Agent 发声

控制台的 **文本转语音（TTS）** 页面统一管理可复用的发声配置。左侧列出已保存服务，右侧编辑配置并试听。同一个服务商可以保存多份音色配置，供不同 Agent 使用。

## 配置与试听

1. 打开 **控制台 → 文本转语音（TTS） → 添加语音服务**，填写名称并选择服务类型。
2. 设置服务地址、语音模型、音色及该类型支持的语速。保存配置不会合成音频或调用思考模型。
3. 保存后输入试听文字，点击 **测试连接并试听**。该按钮实际合成音频，同时验证连接、模型与音色；云端服务会收到试听文字并按供应商规则计费。
4. 浏览器阻止自动播放时，可点击音频播放器播放。关闭控制台、切换服务或分类、修改配置、点击停止试听都会中止当前试听请求和播放。

| 类型                             | 配置                                                        | 发声方式                                                    |
| -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Piper 本地语音                   | 中文 Huayan / 超文 Chaowen / 英文 Lessac 模型，0.5–2 倍语速 | 共享 Speaches 容器，安装模型后离线合成，无需 API Key        |
| 浏览器系统语音（Web Speech API） | 当前设备音色、0.5–2 倍语速；自动音色按中英文选择            | 接收者浏览器通过 `speechSynthesis` 朗读，不要求后端安装 TTS |
| 百炼语音合成                     | 北京或新加坡接口、该地域 API Key、Qwen-TTS 模型及音色       | 调用百炼语音合成接口，下载结果音频，不另行生成回答          |
| 兼容语音接口                     | API Base URL、API Key、模型、音色、语速                     | 请求 `POST /audio/speech`，要求支持 WAV 响应                |

百炼默认模型为 `qwen3-tts-flash`，音色为 `Cherry`；可填写账号和模型支持的其他音色。参数依据 [Qwen-TTS 官方接口](https://help.aliyun.com/en/model-studio/qwen-tts-api)。兼容服务遵循 [Speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)，不代表所有第三方网关均支持该接口。

百炼按模型区分两套协议：`qwen3-tts-*` 使用多模态合成接口；`qwen-audio-3.0-tts-*`、`qwen-audio-3.1-tts-*` 使用 `/services/audio/tts/SpeechSynthesizer`，显式请求 16 kHz WAV。例如 `qwen-audio-3.1-tts-flash` 可搭配 `longanhuan_v3.1`，无需修改已有服务配置。依据 [Qwen-Audio-TTS HTTP API](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api) 和[音色列表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)。试听与 Agent 发声共用此路由；错误按鉴权、模型、音色、限流分类提示，不回显服务商可能包含密钥或试听文字的原始错误体。

Piper 使用共享 `speech` 服务，默认中文 `speaches-ai/piper-zh_CN-huayan-medium`，可选中文超文 `rhasspy/piper-voices/zh_CN-chaowen-medium` 和英文 `speaches-ai/piper-en_US-lessac-medium`。音色由模型决定。控制台点击安装，状态显示“已安装”后即可试听；关闭控制台不取消下载。模型保存于原 `voxel_whisper_cache` 卷，重启后无需重新下载。安装等待上限 10 分钟，失败可刷新重试。合成输出为 16 kHz 单声道 PCM WAV，复用空间播放及取消机制。

超文使用官方 Piper 模型仓库中的 Chaowen medium。`Dockerfile.speech` 固定 Piper 1.8.0，并适配 Speaches 的合成接口。超文安装会一并下载 g2pW 中文发音资源和 BERT 分词词表，校验模型 SHA-256、试合成成功后才标记为已安装。全部资源保存在现有卷的 `.voxel-piper/chaowen-v1` 下；缓存不完整时显示未安装并支持重试，合成时不临时联网下载。已有 Huayan / Lessac 配置与默认模型不变，小雅不在安装目录中。

官方来源：[Chaowen 模型卡](https://huggingface.co/rhasspy/piper-voices/blob/main/zh/zh_CN/chaowen/medium/MODEL_CARD)、[Piper 1.8](https://github.com/OHF-Voice/piper1-gpl/releases/tag/v1.8.0)。模型及依赖各自的许可证仍适用；新版 Piper 使用 GPL-3.0，分发镜像时应包含相应许可与源码义务。

旧 macOS 服务原位迁移到 Piper，保留 ID、自定义名称、语速和 Agent 绑定，清空旧音色。迁移前原文件备份为 `voice-services.json.pre-piper.bak`（仅首次写入）。缺少模型不影响服务器启动，合成时提示安装；不会自动切换云端。回滚时先停止后端并备份当前配置，再将该备份恢复为 `voice-services.json`，配合旧版本代码启动。

地址优先级：ASR 为 `WHISPER_API_URL` → `SPEECH_API_URL` → `http://127.0.0.1:8000/v1`；Piper 为 `PIPER_API_URL` → `SPEECH_API_URL` → `WHISPER_API_URL` → 本地默认地址。空值按未配置处理。其他供应商的音频转换仍可使用 `FFMPEG_BIN`。

## Agent 绑定与运行

浏览器系统语音保存音色名称、语言和语速，不需要地址、模型或密钥。音色列表通过 `getVoices()` 获取，并随 `voiceschanged` 更新；不同玩家设备上的音色可能不同，指定音色不可用时优先回退到同语言本地音色。列表标明本地或远程来源，远程音色可能联网。保存后点击“浏览器试听”，该操作不调用服务器合成接口，也不生成可下载的音频文件。不支持 Web Speech API 时显示错误，文字回复仍然保留。

Agent 使用浏览器服务时，服务器沿用私聊接收者、距离和收听开关校验，仅向允许收听的玩家发送文字及音色参数。客户端排队朗读、去重并跳过过期消息；关闭收听、断开连接、发言者离开或走出可听范围时停止朗读。浏览器朗读使用开始时的音量，不支持现有音频管线的左右声道定位和连续距离衰减。试听与 Agent 朗读共享浏览器队列，新试听会打断旧朗读；浏览器限制自动播放时需点击试听或重新开启收听。服务器合成服务仍使用下述 WAV 下载和空间播放流程。

在 **创建 Agent** 或 **编辑参数** 中选择已保存的 **语音服务**，或选择 **关闭语音 · 仅文字回复**。可以直接在该表单试听所选服务。思考模型继续负责回复内容，语音服务只合成最终回复。

新建 Agent 默认关闭语音；选中服务后启用。已有开启语音但未保存服务 ID 的 Agent 迁移到 `local-default`。已绑定服务的 Agent 可通过卡片开关临时静音，再次开启仍使用该服务。更换绑定须在 Agent 待命时编辑参数，不会重新启动任务。

试听与 Agent 发声走同一个合成实现，使用相同模型、音色及语速。服务端根据可信管理配置解析 Agent 的绑定；世界动作不能指定云端服务或密钥。只有附近已开启收听的真人玩家收到音频；私聊音频只向指定接收者授权，保留原有距离、朝向与音频下载权限规则。

修改绑定或修改被引用服务会取消旧合成和待发送音频；之后的回复使用新配置。合成失败保留文字回复，原因记入 Agent 日志。更换音色不改变 Agent 的任务进度。

## 保存、删除与恢复

- 配置与密钥保存在被 Git 忽略的 `.data/voice-services.json`，文件权限 `0600`，通过临时文件原子替换保存。
- 浏览器只接收 `hasApiKey`；编辑时密钥留空保留原值，更换服务地址或类型必须重新填写密钥。
- 最多保存 20 个服务。被任何已保存 Agent 引用的服务不能删除；请先将关联 Agent 改为其他服务或选择“关闭语音 · 仅文字回复”。临时静音仍保留引用。
- 重启会恢复服务与绑定，但不会自动试听或启动新的模型推理。已保存服务缺失时，该 Agent 保留文字模式并记录提示，不自动改用另一个云端服务。
- 每次合成最多 240 字，服务调用限时 60 秒、最多两次并发。音频统一转换为单声道 16 kHz PCM WAV，最长约 90 秒；不重试结果未知的云端请求。

## 语音识别（ASR）

左侧 **识别服务** 列表包含 **自托管 Whisper** 与各份已保存的 Whisper、本地 SenseVoice、阿里云服务及 OpenAI 兼容接口；点击 **添加识别服务** 可创建命名配置，同一服务商可同时保存不同模型、地域和密钥。右侧可编辑、删除所选配置，下方提供录音试用与识别结果。此选择作用于控制台试用；聊天录音与附近语音按 `ASR_PROVIDER` 选择默认服务器引擎（默认 `auto`：有本地模型时优先 SenseVoice，否则回退 Whisper），不受试用服务删除影响。

### 本地 SenseVoice（离线，推荐）

使用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 在项目服务器内直接运行 SenseVoice-Small，录音不出服务器，不调用云端、不计费。只实现语音转文字，不含唤醒词和声纹识别。

准备工作：

1. 服务器已安装依赖 `sherpa-onnx-node@1.13.8`（随 `pnpm install` 安装，含 macOS、Linux 平台原生库）。
2. 运行 `pnpm voice:sensevoice` 从 k2-fsa 发布页下载 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` 并解压到项目根目录 `models/`（约 150 MiB，无需账号或 API key）；也可手动放入其他 k2-fsa 模型包，或用 `pnpm voice:sensevoice <包名>` 下载指定包。目录须包含 `tokens.txt` 与 `model.int8.onnx`（或 `model.onnx`），目录名须以 `sherpa-onnx-sense-voice` 开头。只有 `models/.gitkeep` 会入库，模型包本身不入库。
3. 启动服务器后，在控制台 **添加识别服务**，**服务类型** 选择 **本地 SenseVoice（服务器离线）**，选择模型与识别语言并保存。

可配置项：

- **识别模型**：`default` 跟随 `SENSE_VOICE_MODEL`，未设置时使用排序后的第一个已安装模型；下拉列表只显示完整可用的模型包。
- **识别语言**：中文（默认）、自动或英文。游戏内聊天与附近语音固定中文；控制台试用按所选语言。

识别行为与限制：

- 浏览器录音沿用 16 kHz 单声道 PCM WAV 快照，直接解码，无需 FFmpeg；上传 WebM、MP4/M4A、OGG 等其他容器时需服务器安装 FFmpeg。
- 音频最长 20 秒、最大 5 MiB；结果超过 240 字会拒绝，无语音返回 `400` 且 `code` 为 `no-speech`。
- 首次识别会加载 int8 计算图（本机约 2 秒、常驻内存约 0.5 GB），之后整个服务器进程复用一个 ONNX 会话；切换语言通过 `setConfig` 即时生效，不会重新加载模型。
- 所有请求在进程内串行解码，避免同会话并发；推理在 sherpa-onnx 原生线程池执行，不阻塞游戏主循环。

环境变量：`ASR_PROVIDER=auto|whisper|sense-voice`（默认 `auto`，按模型是否安装选择默认引擎）、`ASR_MODEL_DIR`（默认项目根目录 `models/`）、`SENSE_VOICE_MODEL`（默认模型目录名）、`ASR_THREADS`（1–16，默认 2）、`FFMPEG_BIN`。

Docker 部署时 `Dockerfile.server` 会在构建阶段把 `models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/` 打包进镜像 `/app/models`，并默认 `ASR_MODEL_DIR=/app/models`、`SENSE_VOICE_MODEL` 指向该包，运行时不依赖宿主机挂载。模型包**不是构建必需项**：未运行 `pnpm voice:sensevoice` 的干净克隆也能构建成功，构建日志会提示跳过打包，运行时 `auto` 自动回退到 Speaches Whisper；需要离线识别时先下载模型再重建镜像。换用其他模型包时，用 `pnpm voice:sensevoice <包名>` 准备后执行 `docker compose build --build-arg SENSE_VOICE_PACK=<目录名> server`；包目录存在但缺少 `tokens.txt` 或 `model*.onnx` 时构建会明确报错并中止。若仍挂载宿主机的 `models/`，挂载内容会覆盖镜像内模型；没有任何模型时 `auto` 自动回退到 Speaches Whisper。

### 阿里云实时识别

1. 点击 **添加识别服务** 并填写服务名称，选择与 API Key 匹配的北京或新加坡地域。可填写业务空间 ID 使用专属域名；留空使用该地域的 DashScope 公共接口。
2. 选择 `fun-asr-realtime`（默认）或 `paraformer-realtime-v2`，填写百炼 API Key 并保存。保存只校验配置，不调用云端模型，也不代表密钥或模型权限已验证。
3. 可再次添加服务，例如分别保存「阿里云 A · Fun-ASR」与「阿里云 B · Paraformer」。从左侧选择要试用的配置，选择中文或英语，点击 **开始录音**。录音使用该服务独立保存的模型和密钥，经项目服务器实时发送到阿里云，按供应商规则计费；无需安装 Whisper。临时字幕可被修正，云端句末事件确认整句。
4. **结束录音** 会先冲刷麦克风尾部 PCM，再发送结束任务指令，等待最后一句与任务完成事件。**取消识别**、切换分类、关闭控制台会释放麦克风并断开云端任务；未确认内容不转为最终结果。

阿里云试用仅支持麦克风实时录音，文件上传使用 Whisper。每次最长 5 分钟，最多两个云端任务并发，连接与尾句确认各限时 15 秒；音频上传积压时停止并提示，不自动重试付费请求。音频为单声道、16 kHz、16 位小端 PCM；服务端收到 `task-started` 后才接受音频，通过 `sentence_end` 区分临时和最终结果。

配置保存在被 Git 忽略的 `.data/asr-settings.json`，权限为 `0600`，原子写入。最多保存 20 份自定义识别服务，旧版单份配置会自动迁移并保留原模型与密钥。API Key 不返回浏览器；编辑时留空只保留当前服务的已保存密钥，新建服务需填写密钥，更换地域或业务空间需重新填写。正在识别的服务不能删除；每次识别请求使用开始时的配置快照，后续请求使用更新后的配置。配置与 WebSocket 入口要求 `WEB_ORIGIN`，云端地址只由受限地域及业务空间 ID 构造。服务端不回显供应商原始错误体。

接口：`GET/POST /voice/asr/services` 读取脱敏列表／新建配置，`PUT/DELETE /voice/asr/services/:id` 编辑／删除指定服务；`WS /voice/asr/realtime?serviceId=<id>&language=zh|en` 连接所选服务。服务 ID 必填，缺失或已删除时不会回退到其他配置。浏览器收到 `ready` 后发送二进制 PCM；发送 `{ "type": "finish" }` 请求结束；服务端返回 `partial`、`final`、`finished` 或 `error` 事件。

协议依据：[实时语音识别指南](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)、[Fun-ASR WebSocket 接入](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api)、[客户端事件](https://help.aliyun.com/zh/model-studio/fun-asr-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/fun-asr-server-events)。自动化测试使用固定响应验证协议、生命周期和权限；真实云端识别效果与账户权限需使用有效 Key 录音验证。

### OpenAI 兼容接口（远程）

点击 **添加识别服务**，**服务类型** 选择 **OpenAI 兼容接口（远程）**，可对接 OpenAI、Groq、硅基流动或自建的 faster-whisper、LocalAI 网关，只要实现 `POST /audio/transcriptions` 的 multipart 契约即可。

- **接口地址**：完整的 http(s) 基地址，例如 `https://api.openai.com/v1`；请求发往 `<接口地址>/audio/transcriptions`，不能包含账号、查询参数或锚点。
- **识别模型**：服务端模型名，例如 `whisper-1`、`whisper-large-v3` 或自建网关暴露的模型 ID。
- **API Key**：可选。OpenAI 等云端服务必须填写，无需鉴权的自建网关可留空；密钥只保存在服务端，不返回浏览器。

录音与文件由项目服务器转发到该地址识别，音频会离开本项目服务器，按供应商规则计费。保存只校验地址与参数格式，不探测网络，实际可用性以录音结果为准。编辑时接口地址不变可留空密钥沿用原值，更换地址须重新填写。该配置只用于控制台试用，聊天与附近语音仍按 `ASR_PROVIDER` 使用默认服务器引擎。

### 自托管 Whisper

点击 **添加识别服务**，将 **服务类型** 设为 **自托管 Whisper**，即可为不同使用场景保存独立名称、模型与参数。可用 **保存并继续添加** 连续创建多份配置，之后从左侧切换、编辑或删除。列表没有固定或不可删除的默认服务。旧版固定 Whisper 入口会在 ASR 配置文件升级到 v3 时一次性转为可编辑、可删除的普通服务；旧列表已满 20 项时保留已有服务，不再补项。删除后刷新或重启不重建。全新配置为空时直接添加服务。聊天和附近语音继续使用独立的服务器环境配置，不受试用服务删除影响。

每份 Whisper 服务可设置：

- **识别模型**：服务器默认模型（`WHISPER_MODEL`）或 `.data/voice/` 下已安装的 `ggml-*.bin` 模型。页面只列出已安装文件，不会自动下载模型；文件缺失时状态检查会提示不可用。
- **线程数**：1–16，默认 4。
- **搜索宽度（Beam size）**：1–8，默认 5。
- **采样温度**：0–1，默认 0。
- **提示词**：可选，最多 500 字，用于术语或文字风格提示。

保存后，录音的临时字幕、最终句子和文件上传均按所选服务 ID 使用这些参数。所有 Whisper 配置共用原有的限流队列和取消机制。`GET /voice/capabilities?serviceId=<id>` 检查指定模型，并在 `senseVoiceModels` 中列出本地 SenseVoice 模型包；`POST /voice/transcribe?serviceId=<id>&language=zh|en` 执行指定配置。省略 ID 保留默认识别行为；提供不存在或非服务器识别服务（如百炼实时）的 ID 则报错，不回退到其他服务。

中文 Whisper 请求默认附带提示词“以下是简体中文的语音转写。”，引导模型输出简体。该默认提示同时适用于本地 CLI、Docker API、临时字幕、最终句子和文件转写；已填写的自定义提示词优先。非中文请求不附加该默认提示。结果直接使用模型输出，不进行简繁转换。

控制台在 TTS 右侧提供独立的 **语音识别（ASR）** 页面，可检查当前服务器识别服务是否就绪、重新检查连接，选择中文或英语，通过录音或上传音频文件试用转写。文件上传支持 WAV、WebM、MP4/M4A、OGG，最长 20 秒、最大 5 MiB。实时录音每次最长 5 分钟，显示可修正的临时字幕及逐句追加的确认文字。识别结果仅显示在试用区域，不发送聊天，也不触发 Agent。

讲话过程中持续滚动识别，约 0.9 秒停顿后重新识别完整句子并确认；连续讲话达到 12 秒时会分句，避免无限缓冲。点击“结束录音”提交最后一句；点击“取消识别”、切换分类或关闭控制台会停止录音并取消识别请求。试用会避让聊天录音，并在开始录音时关闭附近语音麦克风。语言选择只作用于这次试用。取消会丢弃未确认内容，已确认结果保留。识别失败不把临时字幕当作最终结果，也不重放结果未知的请求。

实现使用 AudioWorklet 连续采集 16 kHz PCM，每约 1.2 秒将当前句子的完整 WAV 快照上传识别。临时结果可以覆盖修正，停顿后的最终结果按句子顺序提交。它是向服务器提交音频快照的滚动识别，不是原生流式解码；Docker 复用已加载的模型，延迟取决于模型、CPU 和服务负载。短句可能在临时推理完成前已结束，直接出现最终结果。该流程对自托管 Whisper 与本地 SenseVoice 通用。

服务端共用串行识别队列，临时请求不排队，最终请求最多等待 4 个。浏览器最多保留两个待确认句子，积压时停止并提示，不悄悄丢句继续发送。临时推理最多 8 秒，实时客户端最终请求最多等待 35 秒；取消和断开会中断识别并清理音频资源。

### 浏览器语音识别（Web Speech API）

ASR 左侧仅列出已保存的识别服务，浏览器识别与其他服务采用相同的列表和编辑表单，均可删除。旧版浏览器配置列表升级时，将原固定入口一次性转为普通服务（列表已满时不补项）；持久化版本记录保证删除后不会自动重建。全新浏览器存储为空时不自动创建服务。无需服务器配置或 API Key。该实现完全在 Web 端，调用 `SpeechRecognition`（兼容 `webkitSpeechRecognition`），不经过项目后端，也不上传音频到项目服务器。切换到此服务时取消项目服务列表与能力检查，不受后端就绪状态影响。

也可点击「添加识别服务」，将「服务类型」选择为「浏览器语音识别（Web Speech API）」，填写自定义名称并选择主要识别语言，保存后会加入左侧列表。支持多份配置、编辑、删除及保存并继续添加，每个浏览器最多 20 份。配置仅保存在当前站点的浏览器存储中，不上传后端，不跨设备或浏览器同步；清理站点数据会删除配置。存储不可用或已有数据损坏时明确报错，不假装保存成功或覆盖损坏数据。录音使用所选配置已保存的语言，修改后需保存才能试用。

提供 33 个主要识别语言及地区选项，包括普通话、粤语、英语、日语、韩语、法语、德语、西班牙语等；选项不代表浏览器一定支持，每次仅指定一种主要语言。浏览器与服务器服务分别保留本次页面中的语言选择，切换服务不会把浏览器语言误传给只接通中英文的服务器识别。支持连续识别、临时字幕修正及逐句确认；只有 `isFinal` 结果写入确认文字，同一个结果不会重复追加。结束录音调用 `stop()` 等待浏览器最终结果；取消、切换分类或关闭控制台调用 `abort()`，丢弃临时字幕并忽略迟到回调。最长录音 5 分钟，结束确认最多等待 10 秒；浏览器提前结束时可以手动重新开始，不自动重启麦克风。试用不会发送聊天或触发 Agent，聊天及附近语音仍使用原有 Whisper 链路。

浏览器支持不统一，接口存在也不代表在线服务必定可用。页面需使用 HTTPS 或 localhost；不支持时禁用录音并提示。麦克风权限、网络、无语音及语言不支持错误分别显示。这里只支持麦克风，不提供文件上传。[MDN SpeechRecognition 文档](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)说明部分浏览器将音频发送到其在线识别服务，因此不保证离线。

### 识别服务与实时对话

这份服务列表管理 **语音合成（TTS）**。聊天录音和附近语音使用 `ASR_PROVIDER` 选择的默认引擎（默认 `auto`：本地 SenseVoice 优先，未安装模型时回退 Whisper），配置 Agent 的发声服务不会改变玩家录音或转写方式。

默认连接 Speaches HTTP 服务。若仍需 CLI 模式，在未配置识别/统一 API 地址时显式设置 `WHISPER_BIN=whisper-cli` 或 `WHISPER_MODEL`；例如 macOS 开发环境可用：

```sh
brew install whisper-cpp ffmpeg
pnpm voice:setup
# 在 .env 中配置 WHISPER_BIN=whisper-cli
```

模型位于 `.data/voice/ggml-base.bin`，也可以设置 `WHISPER_MODEL`、`WHISPER_BIN`、`FFMPEG_BIN`。Whisper、模型文件和 FFmpeg 部署在项目服务器上，玩家电脑无需安装。录音使用浏览器麦克风权限并上传至项目服务器识别；使用方式见 [聊天与附近语音](CHAT.md)。

原来的回声、Ollama、Mock 和百炼实时对话实验入口已从控制台移除。Ollama 仍可作为 Agent 思考模型；百炼实时对话协议保留独立开发验收，见 [实时语音协议](ALIYUN_REALTIME.md)，它不作为本轮 Agent TTS 服务。

## 接口与验证

语音管理接口复用 `/ai-characters` 的 Origin 检查与 JSON 请求约束：

- `GET /voice/tts/services`：读取不含密钥的服务列表。
- `POST /voice/tts/services` / `PUT /voice/tts/services/:id`：创建和更新配置。
- `DELETE /voice/tts/services/:id`：删除未被引用的配置。
- `POST /voice/tts/services/:id/preview`：`{ text }`，返回 `audio/wav`，断开请求取消合成。
- `GET /voice/tts/piper/models`：固定模型目录与安装状态。
- `POST /voice/tts/piper/install`：`{ model }`，返回 `202`；同模型复用任务，不同模型同时安装返回 `409`。
- Agent 创建/更新支持 `voiceServiceId`，`voiceReplies` 仍控制是否发声。

```sh
pnpm check
pnpm format:check
pnpm test:voice:services
pnpm test:voice:live # 固定响应的滚动字幕 HTTP 联调
ASR_TEST_WAV=/absolute/path/mono-16khz.wav pnpm test:voice:live # 真实 Whisper，实时速率回放
REAL_TTS=1 pnpm test:voice:services # 真实 Piper 合成（先安装中文模型）
```

集成测试使用临时配置、隔离内存世界、固定思考模型及本机兼容 TTS 测试接口，覆盖保存、试听、不同 Agent 音色、修改绑定、私聊隔离、删除保护和恢复。`REAL_TTS=1` 额外验证 Piper 试听和 Agent 合成音频；不调用付费模型。真实百炼及第三方云端账号、音质、计费需要另行联调。

### Speaches 镜像兼容修复

`Dockerfile.speech` 固定上游摘要并应用两个构建时校验的小补丁：修正误把中日韩文字当作 emoji 删除的 Unicode 范围；模型目录只有在 ONNX 与配置文件下载完成后才返回模型。否则纯中文可能仅生成几十毫秒音频，中断下载也可能被误报为已安装。升级上游镜像时重新审查补丁，不能仅修改摘要跳过检查。
