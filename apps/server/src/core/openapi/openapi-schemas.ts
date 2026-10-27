const text = { type: 'string' };
const integer = { type: 'integer' };
const object = { type: 'object' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const planProperties = {
  name: { ...text, maxLength: 80 },
  goal: { ...text, maxLength: 2000 },
  timeZone: { ...text, example: 'Asia/Shanghai' },
  timing: {
    oneOf: [
      {
        type: 'object',
        required: ['kind'],
        properties: { kind: { ...text, enum: ['immediate'] } },
      },
      {
        type: 'object',
        required: ['kind', 'at'],
        properties: {
          kind: { ...text, enum: ['once'] },
          at: { ...integer, description: '未来时间的 Unix 毫秒时间戳' },
        },
      },
      {
        type: 'object',
        required: ['kind', 'everyMs'],
        properties: {
          kind: { ...text, enum: ['interval'] },
          everyMs: { ...integer, minimum: 60000, maximum: 2678400000 },
        },
      },
      {
        type: 'object',
        required: ['kind', 'time'],
        properties: {
          kind: { ...text, enum: ['daily'] },
          time: { ...text, example: '09:00' },
        },
      },
      {
        type: 'object',
        required: ['kind', 'time', 'weekdays'],
        properties: {
          kind: { ...text, enum: ['weekly'] },
          time: { ...text, example: '09:00' },
          weekdays: {
            type: 'array',
            minItems: 1,
            items: { ...integer, minimum: 0, maximum: 6 },
          },
        },
      },
    ],
  },
  limitsMode: {
    ...text,
    enum: ['inherit', 'override'],
    description: '新计划默认继承角色额度；已有计划缺省为显式覆盖。',
  },
  limits: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true },
      maxTurns: { ...integer, minimum: 1, maximum: 1000, default: 100 },
      maxStalledTurns: { ...integer, minimum: 1, maximum: 1000, default: 3 },
      tokenBudget: {
        ...integer,
        minimum: 1000,
        maximum: 100000000,
        default: 50000,
      },
      taskTimeoutMs: {
        ...integer,
        minimum: 60000,
        maximum: 21600000,
        default: 900000,
      },
    },
  },
  totalTokenBudget: {
    ...integer,
    minimum: 1000,
    maximum: 1000000000,
    default: 500000,
  },
  totalTokenBudgetEnabled: {
    type: 'boolean',
    description:
      '是否限制重复计划的累计 token 用量；旧计划缺省时沿用原执行限制设置。',
  },
};

const agentProfileProperties = {
  providerId: text,
  name: { ...text, maxLength: 24 },
  model: { ...text, maxLength: 128 },
  roleDescription: { ...text, maxLength: 2000 },
  permissions: {
    type: 'object',
    properties: Object.fromEntries(
      ['move', 'chat', 'place', 'remove'].map((key) => [
        key,
        { type: 'boolean' },
      ]),
    ),
  },
  skills: { type: 'array', items: text },
  voiceReplies: { type: 'boolean' },
  voiceServiceId: text,
  intervalMode: { ...text, enum: ['fixed', 'random'] },
  intervalMs: { ...integer, minimum: 1000, maximum: 60000 },
  intervalMinMs: { ...integer, minimum: 1000, maximum: 60000 },
  intervalMaxMs: { ...integer, minimum: 1000, maximum: 60000 },
  taskLimitsEnabled: { type: 'boolean', default: true },
  maxTurns: { ...integer, minimum: 1, maximum: 1000 },
  maxStalledTurns: { ...integer, minimum: 1, maximum: 1000, default: 3 },
  tokenBudget: { ...integer, minimum: 1000, maximum: 100000000 },
  taskTimeoutMs: { ...integer, minimum: 1000, maximum: 21600000 },
};

const profileTaskExclusion = {
  anyOf: [
    { required: ['startTask'] },
    { required: ['taskTimeZone'] },
    { required: ['goal'], properties: { goal: { not: { enum: [''] } } } },
  ],
};

export const apiSchemas = {
  AICharacterCreate: {
    type: 'object',
    required: ['providerId', 'name'],
    description:
      '只创建角色配置，默认上线待命，不创建计划或执行。joinWorld=false 仅保存离线角色。startTask、taskTimeZone 和非空 goal 返回 400，请使用 Tasks；兼容空 goal。',
    not: profileTaskExclusion,
    properties: {
      ...agentProfileProperties,
      joinWorld: { type: 'boolean', default: true },
    },
  },
  AICharacterProfileUpdate: {
    type: 'object',
    description:
      '只更新角色配置，不创建或替换任务；省略字段沿用原值。startTask、taskTimeZone 和非空 goal 返回 400；空 goal 不会清空已有任务。',
    not: profileTaskExclusion,
    properties: agentProfileProperties,
  },
  ApiError: {
    type: 'object',
    required: ['error'],
    properties: { error: text, code: text },
  },
  TaskPlanCreate: {
    type: 'object',
    required: ['characterId', 'name', 'goal', 'timeZone', 'timing'],
    properties: {
      ...planProperties,
      characterId: text,
      requestId: { ...text, description: '重试创建时复用的请求标识' },
    },
  },
  TaskPlanUpdate: {
    type: 'object',
    properties: {
      ...planProperties,
      characterId: text,
      targetCharacterId: {
        ...text,
        description: '保存时改派至此角色，改派后计划暂停',
      },
    },
    description: '省略的字段沿用已有计划值',
  },
  TaskPlan: {
    type: 'object',
    required: ['id', 'name', 'goal', 'timing', 'state'],
    properties: {
      ...planProperties,
      id: text,
      characterId: text,
      characterName: text,
      revision: integer,
      state: { ...text, enum: ['enabled', 'paused', 'completed', 'archived'] },
      reason: text,
      spentTokens: integer,
      createdAt: integer,
      updatedAt: integer,
      nextRunAt: integer,
      latestRun: ref('TaskRun'),
    },
  },
  TaskRun: {
    type: 'object',
    required: ['id', 'source', 'status', 'snapshot'],
    properties: {
      id: text,
      planId: text,
      characterId: text,
      characterName: text,
      source: { ...text, enum: ['scheduled', 'manual', 'chat', 'legacy'] },
      status: text,
      reason: text,
      scheduledAt: integer,
      startedAt: integer,
      finishedAt: integer,
      totalTokens: integer,
      snapshot: { type: 'object', properties: planProperties },
      task: object,
      logs: { type: 'array', items: text },
    },
  },
  TaskPlanPage: {
    type: 'object',
    required: ['items', 'total'],
    properties: {
      items: { type: 'array', items: ref('TaskPlan') },
      total: integer,
      nextOffset: integer,
    },
  },
  TaskRunPage: {
    type: 'object',
    required: ['items', 'active', 'total'],
    properties: {
      items: { type: 'array', items: ref('TaskRun') },
      active: { type: 'array', items: ref('TaskRun') },
      total: integer,
      nextOffset: integer,
    },
  },
  AICharacterView: {
    type: 'object',
    required: ['id', 'name', 'status'],
    properties: { id: text, name: text, status: text, task: object },
    description:
      '控制当前执行时返回的 Agent 公开状态，包含当前任务及用量；不含完整日志数组（仅保留 lastLog/lastLogAt），完整历史请调用 GET /ai-characters/{id}/logs。',
  },
  AICharacterLogPage: {
    type: 'object',
    required: ['entries', 'total'],
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text'],
          properties: {
            time: integer,
            text,
          },
        },
      },
      nextCursor: text,
      total: integer,
    },
    description: '运行日志分页，最新在前；nextCursor 省略表示已到最后一页。',
  },
  TaskControl: {
    type: 'object',
    properties: {
      characterId: text,
      tokens: {
        ...integer,
        minimum: 1000,
        description: 'extend 需要追加的 token 额度',
      },
      requestId: text,
      maxTurns: integer,
      tokenBudget: integer,
      taskTimeoutMs: integer,
    },
    description:
      '按 operation 提交控制参数；run 必须提交 requestId，extend 需要 tokens，resume 可调整执行限额。',
  },
};
