import {
  ManagementError,
  MANAGEMENT_EVENTS_VERSION,
} from '@voxel/shared/management';
import { record } from '../../core/http/validation';
export function parseEventConnect(value: unknown) {
  if (
    !record(value) ||
    value.type !== 'connect' ||
    value.version !== MANAGEMENT_EVENTS_VERSION ||
    typeof value.token !== 'string' ||
    value.token.length > 4096
  )
    throw new ManagementError('管理通知握手或协议版本无效。', 'BAD_HANDSHAKE');
  return { token: value.token };
}
