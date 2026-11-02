export { installAsrHttp, type AsrRouteDependencies } from './routes/asr.http';
export {
  AsrSettingsStore,
  defaultAsrSettingsStore,
} from './persistence/asr-settings-store';
export { DatabaseAsrServicePersistence } from './persistence/database-asr-services';
export { installAsrSocket, type AsrBridge } from './sockets/asr.socket';
import { LocalSpeech } from './services/local-speech.service';
export { LocalSpeech };
export const defaultLocalSpeech = new LocalSpeech();
export { scheduleSpeech } from './services/speech-scheduler.service';
