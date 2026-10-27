export type AsrChoice = {
  id: string;
  name: string;
  provider: 'whisper' | 'bailian' | 'browser';
  language?: string;
};
