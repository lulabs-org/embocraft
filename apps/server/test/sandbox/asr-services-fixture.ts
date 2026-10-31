import { createTestServer } from '../helpers/test-server';
import { LocalSpeech } from '../../src/modules/asr/services/local-speech.service';
// UI fixture only: temporary settings, deterministic transcription, no cloud/model credentials.
const speech = new LocalSpeech();
speech.status = async () => ({ available: true, reason: 'sandbox fixture' });
speech.transcribe = async () => '这是受控测试沙箱的识别结果。';
const server = await createTestServer({
  port: 2597,
  origin: 'http://127.0.0.1:5187',
  speech,
});
console.log(
  `ASR services sandbox: ${server.httpUrl}; temporary settings only.`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
