/**
 * AsyncAPI 3.0 规范定义与文档渲染
 * 用于描述服务端的 WebSocket 接口（实时语音识别与管理控制台网关）
 */

export const asyncApiSpec = {
  asyncapi: '3.0.0',
  info: {
    title: 'EmboCraft WebSocket API',
    version: '1.0.0',
    description:
      'EmboCraft 服务端 WebSocket 接口协议规范。提供实时流式语音识别（Realtime ASR）与 AI 角色管理网关（Management Gateway）长连接。REST 接口请参阅 OpenAPI 文档 (/api-docs)。',
  },
  defaultContentType: 'application/json',
  servers: {
    websocketServer: {
      host: 'localhost:2567',
      pathname: '/',
      protocol: 'ws',
      description: '当前 EmboCraft WebSocket 服务器（默认端口 2567）',
    },
  },
  channels: {
    realtimeAsr: {
      address: '/voice/asr/realtime',
      title: '实时语音识别通道 (Realtime ASR)',
      summary:
        '客户端上行 PCM 音频分片流，服务端下发流式中间片段与最终定稿识别结果',
      description:
        '通过 WebSocket 连接已保存的 ASR 服务提供商（如阿里云百炼）。客户端以二进制流形式持续发送 PCM 语音分片，服务端实时推送识别事件与分句识别结果。服务限制最大并发识别任务数为 2。',
      bindings: {
        ws: {
          bindingVersion: '0.1.0',
          query: {
            type: 'object',
            required: ['language', 'serviceId'],
            properties: {
              language: {
                type: 'string',
                enum: ['zh', 'en'],
                description: '识别语言偏好（目前支持 zh 或 en）',
              },
              serviceId: {
                type: 'string',
                description: '已保存的 ASR 语音识别服务配置 ID',
              },
            },
          },
          headers: {
            type: 'object',
            properties: {
              origin: {
                type: 'string',
                description:
                  '请求来源 Origin，服务端必须校验是否匹配允许的前端 Origin',
              },
            },
          },
        },
      },
      messages: {
        audioChunk: {
          $ref: '#/components/messages/AsrAudioChunk',
        },
        asrReady: {
          $ref: '#/components/messages/AsrReadyEvent',
        },
        asrPartial: {
          $ref: '#/components/messages/AsrPartialEvent',
        },
        asrFinal: {
          $ref: '#/components/messages/AsrFinalEvent',
        },
        asrFinished: {
          $ref: '#/components/messages/AsrFinishedEvent',
        },
        asrError: {
          $ref: '#/components/messages/AsrErrorEvent',
        },
      },
    },
    managementGateway: {
      address: '/ai-characters/gateway',
      title: 'AI 角色控制台网关 (Management Gateway)',
      summary: '管理控制台长连接，接收状态同步与变更通知',
      description:
        '前端管理控制台建立的长连接。连接后需在 5 秒内上报包含管理员 Bearer Token 的握手帧。连接成功后仅用于服务端向前端下发数据变更和快照通知，客户端所有的写操作须通过鉴权的 HTTP 接口发起。',
      bindings: {
        ws: {
          bindingVersion: '0.1.0',
          headers: {
            type: 'object',
            properties: {
              origin: {
                type: 'string',
                description: '请求来源 Origin',
              },
            },
          },
        },
      },
      messages: {
        connectRequest: {
          $ref: '#/components/messages/GatewayConnectRequest',
        },
        connectedNotification: {
          $ref: '#/components/messages/GatewayConnectedNotification',
        },
        snapshotNotification: {
          $ref: '#/components/messages/GatewaySnapshotNotification',
        },
        changedNotification: {
          $ref: '#/components/messages/GatewayChangedNotification',
        },
        errorNotification: {
          $ref: '#/components/messages/GatewayErrorNotification',
        },
      },
    },
  },
  operations: {
    sendAudioStream: {
      action: 'send',
      channel: {
        $ref: '#/channels/realtimeAsr',
      },
      summary: '客户端流式发送音频 PCM 分片',
      description:
        '客户端建立 WebSocket 连接后，持续发送 16000Hz 16-bit 单声道 PCM 二进制分片。录音结束时断开或关闭连接。',
      messages: [{ $ref: '#/channels/realtimeAsr/messages/audioChunk' }],
    },
    receiveAsrEvents: {
      action: 'receive',
      channel: {
        $ref: '#/channels/realtimeAsr',
      },
      summary: '客户端接收实时识别事件与文字结果',
      description:
        '服务端流式下发识别准备完成、临时片段、确认句子、完成或错误事件。',
      messages: [
        { $ref: '#/channels/realtimeAsr/messages/asrReady' },
        { $ref: '#/channels/realtimeAsr/messages/asrPartial' },
        { $ref: '#/channels/realtimeAsr/messages/asrFinal' },
        { $ref: '#/channels/realtimeAsr/messages/asrFinished' },
        { $ref: '#/channels/realtimeAsr/messages/asrError' },
      ],
    },
    sendGatewayHandshake: {
      action: 'send',
      channel: {
        $ref: '#/channels/managementGateway',
      },
      summary: '客户端发送管理网关认证握手帧',
      description:
        '连接建立后 5 秒内必须向服务端发送文本 JSON 认证帧，携带管理员令牌。超出时间未认证或令牌错误将主动断开连接。',
      messages: [
        { $ref: '#/channels/managementGateway/messages/connectRequest' },
      ],
    },
    receiveGatewayEvents: {
      action: 'receive',
      channel: {
        $ref: '#/channels/managementGateway',
      },
      summary: '客户端接收网关状态和数据变更通知',
      description:
        '服务端在握手成功后首先推送版本和快照帧，之后当后端发生实体变更（如角色、任务等）时推送变更事件帧。',
      messages: [
        { $ref: '#/channels/managementGateway/messages/connectedNotification' },
        { $ref: '#/channels/managementGateway/messages/snapshotNotification' },
        { $ref: '#/channels/managementGateway/messages/changedNotification' },
        { $ref: '#/channels/managementGateway/messages/errorNotification' },
      ],
    },
  },
  components: {
    messages: {
      AsrAudioChunk: {
        name: 'AsrAudioChunk',
        title: '音频二进制分片',
        summary: '16000Hz 16-bit 单声道 PCM 二进制音频数据',
        contentType: 'application/octet-stream',
        payload: {
          type: 'string',
          format: 'binary',
          description: 'PCM 16kHz 16-bit 单声道原始音频二进制分片',
        },
      },
      AsrReadyEvent: {
        name: 'AsrReadyEvent',
        title: '识别服务准备就绪',
        summary: '云端识别任务已建立并准备好接收音频',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type'],
          properties: {
            type: {
              type: 'string',
              const: 'ready',
              description: '事件类型：就绪',
            },
          },
        },
      },
      AsrPartialEvent: {
        name: 'AsrPartialEvent',
        title: '未定稿识别中间片段',
        summary: '流式返回当前句子的实时识别过程文字',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type', 'text'],
          properties: {
            type: {
              type: 'string',
              const: 'partial',
              description: '事件类型：中间识别片段',
            },
            text: {
              type: 'string',
              description: '当前正在识别的中间文字',
            },
          },
        },
      },
      AsrFinalEvent: {
        name: 'AsrFinalEvent',
        title: '已定稿单句识别结果',
        summary: '标点及断句已定稿的一整句文字',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type', 'text'],
          properties: {
            type: {
              type: 'string',
              const: 'final',
              description: '事件类型：定稿句子',
            },
            text: {
              type: 'string',
              description: '定稿句子的识别文本',
            },
          },
        },
      },
      AsrFinishedEvent: {
        name: 'AsrFinishedEvent',
        title: '识别任务正常结束',
        summary: '云端识别任务正常结束并关闭',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type'],
          properties: {
            type: {
              type: 'string',
              const: 'finished',
              description: '事件类型：结束',
            },
          },
        },
      },
      AsrErrorEvent: {
        name: 'AsrErrorEvent',
        title: '识别异常报错',
        summary: '识别失败或连接被拒绝的错误详情',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type', 'message'],
          properties: {
            type: {
              type: 'string',
              const: 'error',
              description: '事件类型：错误',
            },
            message: {
              type: 'string',
              description: '错误原因说明',
            },
          },
        },
      },
      GatewayConnectRequest: {
        name: 'GatewayConnectRequest',
        title: '网关认证请求',
        summary: '客户端连接后发送的管理员身份认证信息',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type', 'version', 'token'],
          properties: {
            type: {
              type: 'string',
              const: 'connect',
              description: '帧类型：连接握手',
            },
            version: {
              type: 'integer',
              const: 3,
              description: '协议版本号（当前为 3）',
            },
            token: {
              type: 'string',
              description: '管理员 Bearer 认证 Token',
            },
          },
        },
      },
      GatewayConnectedNotification: {
        name: 'GatewayConnectedNotification',
        title: '网关连接就绪通知',
        summary: '服务端确认认证通过并下发协议版本',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type', 'version'],
          properties: {
            type: {
              type: 'string',
              const: 'connected',
              description: '帧类型：已连接',
            },
            version: {
              type: 'integer',
              description: '管理事件协议版本号',
            },
          },
        },
      },
      GatewaySnapshotNotification: {
        name: 'GatewaySnapshotNotification',
        title: '全量快照同步信号',
        summary: '通知客户端通过 HTTP 重新拉取所有全量实体数据',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type', 'seq', 'event', 'data'],
          properties: {
            type: { type: 'string', const: 'event' },
            seq: { type: 'integer', description: '递增消息序列号' },
            event: { type: 'string', const: 'snapshot' },
            data: { type: 'null' },
          },
        },
      },
      GatewayChangedNotification: {
        name: 'GatewayChangedNotification',
        title: '实体变更增量事件',
        summary: '通知客户端有特定模块的实体发生改变',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type', 'seq', 'event', 'data'],
          properties: {
            type: { type: 'string', const: 'event' },
            seq: { type: 'integer', description: '递增消息序列号' },
            event: { type: 'string', const: 'changed' },
            data: {
              type: 'object',
              description: '变更的实体信息（模块、变更类别等）',
            },
          },
        },
      },
      GatewayErrorNotification: {
        name: 'GatewayErrorNotification',
        title: '网关错误通知',
        summary: '认证失败、格式错误或连接被拒绝',
        contentType: 'application/json',
        payload: {
          type: 'object',
          required: ['type', 'error'],
          properties: {
            type: { type: 'string', const: 'error' },
            error: {
              type: 'object',
              required: ['message'],
              properties: {
                message: { type: 'string', description: '错误描述' },
                code: { type: 'string', description: '错误码' },
                statusCode: { type: 'integer', description: 'HTTP 对应状态码' },
              },
            },
          },
        },
      },
    },
  },
};
