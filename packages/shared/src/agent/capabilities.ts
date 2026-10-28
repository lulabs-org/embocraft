export type AICharacterPermissions = {
  move: boolean;
  chat: boolean;
  place: boolean;
  remove: boolean;
};
export type AICharacterSkillId = 'building' | 'exploration' | 'guide';

export const AI_CHARACTER_PERMISSIONS = [
  {
    id: 'move',
    name: '移动与跳跃',
    description: '在世界中移动、跳跃，接近目标或调整观察位置。',
  },
  {
    id: 'chat',
    name: '发送聊天',
    description: '发送文字、任务回执和语音回复；关闭后仍可在控制台查看进展。',
  },
  {
    id: 'place',
    name: '放置方块',
    description: '放置方块、批量建造和搭建房屋，不包含拆除。',
  },
  {
    id: 'remove',
    name: '拆除方块',
    description: '移除已有方块，包括批量操作中的拆除步骤。',
  },
] as const;

export const AI_CHARACTER_SKILLS: ReadonlyArray<{
  id: AICharacterSkillId;
  name: string;
  description: string;
  requires: readonly (keyof AICharacterPermissions)[];
}> = [
  {
    id: 'building',
    name: '建筑规划',
    description: '选址、确认尺寸与风格，分步施工并验收。',
    requires: ['move', 'chat', 'place'],
  },
  {
    id: 'exploration',
    name: '探索勘察',
    description: '观察可见区域，移动检查并汇报发现。',
    requires: ['move', 'chat'],
  },
  {
    id: 'guide',
    name: '导览讲解',
    description: '根据可见环境讲解，按任务带领玩家移动。',
    requires: ['move', 'chat'],
  },
];

export function resolvePermissions(
  value: AICharacterPermissions,
): AICharacterPermissions {
  return {
    move: value.move === true,
    chat: value.chat === true,
    place: value.place === true,
    remove: value.remove === true,
  };
}

export function aiCharacterPermissions(settings: {
  permissions: AICharacterPermissions;
}): AICharacterPermissions {
  return resolvePermissions(settings.permissions);
}
