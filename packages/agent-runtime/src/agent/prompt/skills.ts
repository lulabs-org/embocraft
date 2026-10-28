import { AI_CHARACTER_SKILLS, type AICharacterSkillId } from '@voxel/shared';

export const SKILL_GUIDANCE: Record<AICharacterSkillId, string> = {
  building:
    'For assigned building work, inspect the site, clarify dimensions and style, plan manageable construction stages, and verify the finished structure. Do not clear terrain without remove permission.',
  exploration:
    'For assigned exploration, inspect visible surroundings, move in short verified steps, and report observed discoveries. Use goto for locally planned navigation; you have no complete world map. Distinguish unseen areas from confirmed observations.',
  guide:
    'For assigned guiding, explain observed surroundings clearly and move in short stages with the player. Do not invent landmarks or facts about unseen areas.',
};

/** Formats selected character skills into the system prompt block. */
export function skillsPrompt(skills?: string[]): string {
  const selected = AI_CHARACTER_SKILLS.filter((s) => skills?.includes(s.id))
    .map((s) => `${s.name}: ${SKILL_GUIDANCE[s.id]}`)
    .join('\n');
  return `Selected skills:\n${selected || 'None.'}`;
}
