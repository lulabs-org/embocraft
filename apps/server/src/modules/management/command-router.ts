import { CommandQueue } from '../../core/concurrency/command-queue';
import {
  ManagementError,
  type ManagementErrorData,
} from '@voxel/shared/management';
import { publicError } from './errors';

export class CommandRouter extends CommandQueue<ManagementErrorData> {
  constructor() {
    super({
      publicError,
      conflict: () =>
        new ManagementError('同一命令标识不能用于不同操作。', 'CONFLICT', 409),
    });
  }
}
