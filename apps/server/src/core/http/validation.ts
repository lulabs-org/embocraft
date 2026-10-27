import { AppError } from '../errors/app-error';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('请求格式无效。');
  return value as Record<string, unknown>;
}

export function text(
  value: unknown,
  label: string,
  max: number,
  fallback = '',
) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max)
    throw new AppError(`${label}格式无效。`);
  return value.trim();
}

export function integer(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new AppError(`${label}须为 ${min}–${max} 的整数。`);
  return value;
}

export function boolean(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AppError('开关参数无效。');
  return value;
}

/** 服务端请求标识守卫：仅允许短横线、下划线与字母数字 */
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

/** 服务端请求体守卫：判定为非数组的普通对象并收窄类型 */
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
