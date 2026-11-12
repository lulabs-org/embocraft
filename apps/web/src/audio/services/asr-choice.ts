export type AsrChoice = {
  id: string;
  name: string;
  // sense-voice 是项目服务器内的离线引擎，与云端实时识别分开列出，
  // 以便后续按 provider 选择分段 HTTP 还是长连接通道。
  provider:
    | 'whisper'
    | 'sense-voice'
    | 'bailian'
    | 'browser'
    | 'openai'
    | 'gemini';
  language?: string;
};
