import { randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors';
import { validateProviderInput } from './domain/validation';
import type { SavedProvider } from './domain/model';

export type { SavedProvider } from './domain/model';

/** Apply create/update semantics after the domain has validated the request. */
export function validateProvider(
  value: unknown,
  previous?: SavedProvider,
): SavedProvider {
  const input = validateProviderInput(value);
  if (
    previous?.apiKey &&
    !input.apiKey &&
    (new URL(previous.baseUrl).origin !== new URL(input.baseUrl).origin ||
      previous.type !== input.type)
  ) {
    throw new AppError('更换服务地址或类型时，请重新填写 API Key。');
  }

  return {
    id: previous?.id ?? randomUUID(),
    ...input,
    apiKey: input.apiKey || previous?.apiKey || '',
  };
}
