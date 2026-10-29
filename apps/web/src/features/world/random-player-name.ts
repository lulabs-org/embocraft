import type { Language } from '../../i18n/types';

const words = {
  zh: {
    adjectives: [
      '悠然',
      '追风',
      '晴空',
      '漫游',
      '星光',
      '晨曦',
      '轻快',
      '勇敢',
    ],
    nouns: ['小鹿', '白鹭', '松鼠', '云雀', '海獭', '山猫', '赤狐', '熊猫'],
  },
  en: {
    adjectives: [
      'Sunny',
      'Brave',
      'Merry',
      'Cosmic',
      'Misty',
      'Swift',
      'Quiet',
      'Lucky',
    ],
    nouns: ['Deer', 'Heron', 'Otter', 'Lark', 'Fox', 'Panda', 'Lynx', 'Robin'],
  },
};

export function randomPlayerName(
  language: Language,
  currentName: string,
): string {
  const { adjectives, nouns } = words[language];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(Math.random() * 900) + 100;
  const name = `${adjective}${noun}${suffix}`;
  return name === currentName.trim()
    ? `${adjective}${noun}${suffix === 999 ? 100 : suffix + 1}`
    : name;
}
