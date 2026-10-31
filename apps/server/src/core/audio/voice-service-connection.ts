import type { VoiceServiceDraft, VoiceServiceType } from '@voxel/shared';
import { AppError } from '../errors/app-error';

type Connection = Pick<VoiceServiceDraft, 'type' | 'baseUrl' | 'apiKey'>;

/** Shared by saving profiles and read-only discovery of an unsaved endpoint. */
export function validateVoiceConnection(
  input: Record<string, unknown>,
  type: VoiceServiceType,
  previous?: Connection,
): Connection {
  if (type === 'browser') return { type, baseUrl: '', apiKey: '' };
  const str = (key: string, max: number) => {
    const value = input[key] ?? '';
    if (
      typeof value !== 'string' ||
      value.length > max ||
      /[\r\n\0]/.test(value)
    )
      throw new AppError(`${key} 格式无效。`);
    return value.trim();
  };
  const address = str('baseUrl', 500);
  let baseUrl = '',
    local = false;
  if (address || type !== 'speaches') {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new AppError('请填写有效的语音接口地址。');
    }
    local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !((local || type === 'speaches') && url.protocol === 'http:'))
    )
      throw new AppError(
        type === 'speaches'
          ? 'Speaches 接口须为 HTTP 或 HTTPS 地址，不能包含凭据或查询参数。'
          : '语音接口须为 HTTPS 或本机 HTTP 地址，不能包含凭据或查询参数。',
      );
    baseUrl = url.href.replace(/\/+$/, '');
  }
  if (
    type === 'bailian' &&
    ![
      'https://dashscope.aliyuncs.com/api/v1',
      'https://dashscope-intl.aliyuncs.com/api/v1',
    ].includes(baseUrl)
  )
    throw new AppError('百炼请选择北京或新加坡官方接口。');
  let apiKey = str('apiKey', 4096);
  if (!apiKey && previous?.apiKey) {
    if (previous.type !== type || previous.baseUrl !== baseUrl)
      throw new AppError('更换类型或地址时，请重新填写密钥。');
    apiKey = previous.apiKey;
  }
  if (!apiKey && !local && type !== 'speaches')
    throw new AppError('请填写语音服务 API Key。');
  return { type, baseUrl, apiKey };
}
