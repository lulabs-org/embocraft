import {
  AI_CHARACTER_LOG_MAX_PAGE_SIZE,
  AI_CHARACTER_LOG_PAGE_SIZE,
  type AICharacterLogPage,
} from '@voxel/shared';
import type { CharacterQueryPort } from '../persistence/queries';

export interface CharacterLogQueryOptions {
  limit?: unknown;
  cursor?: unknown;
}

/**
 * 负责 AI 角色历史日志分页查询、游标加解密与参数边界规范化
 */
export class CharacterLogService {
  constructor(private readonly queries: Pick<CharacterQueryPort, 'logs'>) {}

  /**
   * 分页获取 AI 角色历史日志
   */
  async getLogsPage(
    id: string,
    options: CharacterLogQueryOptions = {},
  ): Promise<AICharacterLogPage> {
    const limit = this.parseLimit(options.limit);
    const offset = this.decodeCursor(options.cursor);
    const { entries, total } = await this.queries.logs(id, limit, offset);
    const nextOffset = offset + entries.length;

    return {
      entries,
      total,
      nextCursor:
        nextOffset < total ? this.encodeCursor(nextOffset) : undefined,
    };
  }

  /**
   * 将 offset 编码为不透明 base64url 游标
   */
  encodeCursor(offset: number): string {
    return Buffer.from(`v1:${offset}`, 'utf8').toString('base64url');
  }

  /**
   * 解析 base64url 游标为偏移量 offset，非法游标返回 0
   */
  decodeCursor(cursor: unknown): number {
    if (typeof cursor !== 'string' || !cursor) return 0;
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const [version, value] = decoded.split(':');
      if (version !== 'v1') return 0;
      const offset = Number(value);
      return Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
    } catch {
      return 0;
    }
  }

  private parseLimit(raw: unknown): number {
    const num = Number(raw ?? AI_CHARACTER_LOG_PAGE_SIZE);
    if (!Number.isFinite(num)) return AI_CHARACTER_LOG_PAGE_SIZE;
    return Math.min(
      Math.max(Math.trunc(num), 1),
      AI_CHARACTER_LOG_MAX_PAGE_SIZE,
    );
  }
}
