# 本地独立语音微服务 (Speaches)

本项目集成了基于 [Speaches](https://github.com/speaches-ai/speaches) 构建的独立语音微服务容器（在 `docker-compose.yml` 中定义为 `speech` 服务）。它完全遵循 **OpenAI Audio API 协议规范**，在单容器内同时承载 **Whisper 语音识别 (ASR)** 与 **Piper 离线语音合成 (TTS)**。

---

## 1. 架构定位与工作流

在 EmboCraft 多人沙盒系统中，服务端与语音服务的调用关系如下：

```
+-----------------------------------------------------------------------------------+
| 客户端 / 浏览器 / AI 玩家                                                           |
+----------------------------------------+------------------------------------------+
                                         | WebSocket / REST
                                         v
+-----------------------------------------------------------------------------------+
| Node.js 后端服务 (voxel-server)                                                    |
|                                                                                   |
|  - ASR 转录调度 (SpeechSchedulerService / LocalSpeechService)                      |
|  - TTS 语音生成 (PiperTts)                                                         |
|  - 端点解析: speechEndpoint('whisper' | 'piper')                                   |
+----------------------------------------+------------------------------------------+
                                         | HTTP (内网 http://speech:8000/v1)
                                         v
+-----------------------------------------------------------------------------------+
| 语音微服务容器 (voxel-speech / Dockerfile.speech)                                   |
|                                                                                   |
|  +-----------------------------------+   +-------------------------------------+  |
|  | Whisper 语音识别 (ASR)             |   | Piper 离线语音合成 (TTS)            |  |
|  | - 引擎: faster-whisper (int8)     |   | - 引擎: piper-tts 1.8.0             |  |
|  | - 模型: Systran/faster-whisper-base|   | - 补丁: 中文 g2pW 词表与 CJK 发音增强|  |
|  +-----------------------------------+   +-------------------------------------+  |
|                                                                                   |
|  挂载卷持久化缓存: /home/ubuntu/.cache/huggingface/hub (speech_cache)             |
+-----------------------------------------------------------------------------------+
```

### 核心特性
- **轻量 CPU 推理**：Whisper 采用 `int8` 量化计算 (`WHISPER__COMPUTE_TYPE: int8`)，内存与 CPU 开销极低。
- **防止重复加载**：配置 `WHISPER__TTL: -1`，常驻内存，避免闲置 5 分钟后被卸载导致的冷启动延迟。
- **离线模型持久化**：首次拉取或合成的语音模型保存在 Docker 命名卷 `voxel_whisper_cache` 中，容器重建或系统重启后无需重新下载。
- **标准 OpenAI API 格式**：使用标准 `/v1/audio/transcriptions` 和 `/v1/audio/speech` 路由，方便替换或与外部第三方兼容服务平替。

---

## 2. Docker 编排配置

在项目根目录的 `docker-compose.yml` 中配置如下：

```yaml
services:
  speech:
    build:
      context: .
      dockerfile: Dockerfile.speech
    container_name: voxel-speech
    restart: unless-stopped
    environment:
      # CPU 推理优化：int8 降低算力开销；-1 保持常驻内存不卸载
      WHISPER__COMPUTE_TYPE: int8
      WHISPER__TTL: -1
      # 提升 Docker Desktop 或网络代理环境下 Hugging Face 下载稳定性
      HF_HUB_DISABLE_XET: '1'
    networks:
      default:
        aliases: [whisper]  # 兼容保留旧版 whisper 别名解析
    volumes:
      - speech_cache:/home/ubuntu/.cache/huggingface/hub
    ports:
      - '${SPEECH_PORT:-${WHISPER_PORT:-8000}}:8000'

  server:
    # ...
    depends_on:
      speech:
        condition: service_started
    environment:
      # 后端连接语音服务的内部地址
      SPEECH_API_URL: '${SPEECH_API_URL:-http://speech:8000/v1}'
```

### 环境变量说明

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SPEECH_PORT` / `WHISPER_PORT` | `8000` | 宿主机映射端口（如 `http://localhost:8000`） |
| `SPEECH_API_URL` | `http://speech:8000/v1` | 后端服务调用语音微服务的内网统一基础地址 |

---

## 3. 支持的模型列表

语音服务启动后，内置或支持自动按需加载以下模型：

### 文本转语音 (TTS)
| 模型标识 (`model`) | 说话人 (`voice`) | 语言 | 特点 |
| :--- | :--- | :--- | :--- |
| `speaches-ai/piper-zh_CN-huayan-medium` | `huayan` | 中文 (zh) | 系统默认中文女声，语速自然，资源消耗低 |
| `rhasspy/piper-voices/zh_CN-chaowen-medium` | `chaowen` | 中文 (zh) | 超文中文男声，结合 `g2pW` 多音字优化，播音质感 |
| `speaches-ai/piper-en_US-lessac-medium` | `lessac` | 英文 (en) | 标准美式英文女声 |

### 语音转文字 (ASR)
| 模型标识 (`model`) | 任务 | 语言支持 |
| :--- | :--- | :--- |
| `Systran/faster-whisper-base` | `transcription` | 支持中、英、日、法、德等 99+ 种语言转写 |

---

## 4. 后端内部调用细节

后端服务源码中主要通过两个模块发起 HTTP 通信：

### (1) 端点解析 (`speechEndpoint`)
位于 `apps/server/src/modules/audio/speech-endpoint.ts`：
```typescript
export function speechEndpoint(engine: 'whisper' | 'piper') {
  const c = env.readSpeech();
  const urls =
    engine === 'whisper'
      ? [c.whisperApiUrl, c.speechApiUrl]
      : [c.piperApiUrl, c.speechApiUrl, c.whisperApiUrl];
  return (
    urls.map((url) => url?.trim()).find(Boolean) || 'http://127.0.0.1:8000/v1'
  ).replace(/\/+$/, '');
}
```

### (2) 语音合成调用 (`PiperTts`)
位于 `apps/server/src/modules/audio/services/tts/piper.service.ts`：
```typescript
const response = await fetch(`${this.endpoint}/audio/speech`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'speaches-ai/piper-zh_CN-huayan-medium',
    input: text,
    voice: 'huayan',
    speed: 1,
    response_format: 'wav',
    sample_rate: 16000,
  }),
});
```

### (3) 语音识别调用 (`LocalSpeechService`)
位于 `apps/server/src/modules/audio/services/asr/local-speech.service.ts`：
构建 `FormData` 上传用户录音并提交给 `${this.apiUrl}/audio/transcriptions` 解析文本。

---

## 5. cURL 测试与验证命令

如果部署了服务或需要快速调试，可以在宿主机终端使用以下 `curl` 命令：

### 1. 检查服务健康状态
```bash
curl -i http://localhost:8000/health
```
**期望响应**：
```http
HTTP/1.1 200 OK
content-length: 2

OK
```

### 2. 查询已加载的模型列表
```bash
curl -s http://localhost:8000/v1/models
```
**响应示例**：
```json
{
  "data": [
    { "id": "speaches-ai/piper-zh_CN-huayan-medium", "task": "text-to-speech" },
    { "id": "rhasspy/piper-voices/zh_CN-chaowen-medium", "task": "text-to-speech" },
    { "id": "speaches-ai/piper-en_US-lessac-medium", "task": "text-to-speech" },
    { "id": "Systran/faster-whisper-base", "task": "automatic-speech-recognition" }
  ],
  "object": "list"
}
```

### 3. 测试 TTS 语音合成并生成音频文件
```bash
curl -s -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "speaches-ai/piper-zh_CN-huayan-medium",
    "input": "欢迎来到体素智能体世界！",
    "voice": "huayan",
    "response_format": "wav"
  }' \
  --output test_tts.wav
```
验证生成的音频信息：
```bash
file test_tts.wav
# 输出类似：test_tts.wav: RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 22050 Hz
```

### 4. 测试 Whisper 语音识别
将生成的 `test_tts.wav` 直接送入 Whisper 进行识别：
```bash
curl -s -X POST http://localhost:8000/v1/audio/transcriptions \
  -F "file=@test_tts.wav" \
  -F "model=Systran/faster-whisper-base" \
  -F "language=zh"
```
**期望响应**：
```json
{"text":"欢迎来到体素智能体世界！"}
```

---

## 6. 常见问题排查

1. **容器启动冲突：`The container name "/voxel-speech" is already in use`**
   - 原因：存在已残留的未删除同名旧容器。
   - 解决：`docker rm -f voxel-speech` 后重新执行 `docker compose up -d speech`。
2. **首次合成或识别较慢**
   - 首次使用某个模型时，Speaches 会从 Hugging Face Hub 下载模型权重文件。下载完成后将缓存到 Docker 卷 `voxel_whisper_cache`，后续调用即可毫秒级响应。
3. **独立运行与本地开发连接**
   - 若你在宿主机使用 `pnpm dev` 运行服务端，本地环境变量默认通过 `speechEndpoint` 解析为 `http://127.0.0.1:8000/v1`，直接兼容 Docker 映射出来的 8000 端口，无需额外复杂配置。
