import { randomUUID } from 'node:crypto';
import { AppError } from '../../../common/errors';
import { object, text } from '../../../common/validation';
import type { ProviderDraft, ProviderView } from '@voxel/shared';
import { validateProviderInput } from './validation';

/** Persisted provider configuration; the API key must not be exposed in views. */
export type SavedProvider = ProviderDraft & {
  id: string;
};

/**
 * Strip the plaintext API key from a saved provider and return a public view
 * indicating only whether a key has been configured (`hasApiKey: boolean`).
 */
export function toProviderView({
  apiKey,
  ...view
}: SavedProvider): ProviderView {
  return { ...view, hasApiKey: !!apiKey };
}

/** Create or update a provider while preserving a key only for the same origin and type. */
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

/** Restore and validate an already persisted provider (verifying its ID and settings). */
export function restoreSavedProvider(value: unknown): SavedProvider {
  const item = object(value);
  const id = text(item.id, '服务 ID', 80);
  if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) {
    throw new AppError('无效的模型服务 ID。');
  }
  return {
    id,
    ...validateProviderInput(item),
  };
}
