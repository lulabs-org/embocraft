import {
  ManagementError,
  type ManagementErrorData,
} from '@voxel/shared/management';
import { record } from '../../core/http/validation';
export function publicError(error: unknown): ManagementErrorData {
  if (error instanceof ManagementError)
    return { code: error.code, message: error.message, status: error.status };
  const status =
    record(error) && typeof error.status === 'number' ? error.status : 500;
  return {
    code:
      status === 409
        ? 'CONFLICT'
        : status === 404
          ? 'NOT_FOUND'
          : status === 429
            ? 'BUSY'
            : status >= 500
              ? 'INTERNAL'
              : 'INVALID_REQUEST',
    message:
      status < 500 && error instanceof Error
        ? error.message
        : '操作未完成，请检查服务状态或存储权限。',
    status,
  };
}
