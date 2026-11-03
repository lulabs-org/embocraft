import { expect, it } from 'vitest';
import { ManagementError } from '@voxel/shared/management';
import { publicError } from './public-error';

it('returns data directly for ManagementError instances', () => {
  const err = new ManagementError('参数错误', 'BAD_PARAMS', 400);
  expect(publicError(err)).toEqual({
    code: 'BAD_PARAMS',
    message: '参数错误',
    status: 400,
  });
});

it('maps 404 status to NOT_FOUND with error message', () => {
  const err = Object.assign(new Error('未找到资源'), { status: 404 });
  expect(publicError(err)).toEqual({
    code: 'NOT_FOUND',
    message: '未找到资源',
    status: 404,
  });
});

it('maps 409 status to CONFLICT', () => {
  const err = Object.assign(new Error('资源已存在'), { status: 409 });
  expect(publicError(err)).toEqual({
    code: 'CONFLICT',
    message: '资源已存在',
    status: 409,
  });
});

it('maps 429 status to BUSY', () => {
  const err = Object.assign(new Error('请求过多'), { status: 429 });
  expect(publicError(err)).toEqual({
    code: 'BUSY',
    message: '请求过多',
    status: 429,
  });
});

it('maps general 4xx status to INVALID_REQUEST', () => {
  const err = Object.assign(new Error('无效请求'), { status: 422 });
  expect(publicError(err)).toEqual({
    code: 'INVALID_REQUEST',
    message: '无效请求',
    status: 422,
  });
});

it('maps 500+ status to INTERNAL with generic message', () => {
  const err = Object.assign(new Error('数据库崩溃'), { status: 500 });
  expect(publicError(err)).toEqual({
    code: 'INTERNAL',
    message: '操作未完成，请检查服务状态或存储权限。',
    status: 500,
  });
});

it('defaults unknown errors to status 500 and INTERNAL code', () => {
  expect(publicError('something went wrong')).toEqual({
    code: 'INTERNAL',
    message: '操作未完成，请检查服务状态或存储权限。',
    status: 500,
  });
});
