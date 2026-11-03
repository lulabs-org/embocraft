import {
  ManagementError,
  type ManagementErrorData,
} from '@voxel/shared/management';
import { record } from '../http/validation';

function statusToErrorCode(status: number): string {
  switch (status) {
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'BUSY';
    default:
      return status >= 500 ? 'INTERNAL' : 'INVALID_REQUEST';
  }
}

export function publicError(error: unknown): ManagementErrorData {
  if (error instanceof ManagementError)
    return { code: error.code, message: error.message, status: error.status };
  const status =
    record(error) && typeof error.status === 'number' ? error.status : 500;
  return {
    code: statusToErrorCode(status),
    message:
      status < 500 && error instanceof Error
        ? error.message
        : '操作未完成，请检查服务状态或存储权限。',
    status,
  };
}
