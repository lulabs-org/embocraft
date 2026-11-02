import { describe, expect, it, vi } from 'vitest';
import {
  AI_CHARACTER_LOG_MAX_PAGE_SIZE,
  AI_CHARACTER_LOG_PAGE_SIZE,
} from '@voxel/shared';
import { CharacterLogService } from './character-log.service';

describe('CharacterLogService', () => {
  it('encodes and decodes cursors round-trip', () => {
    const service = new CharacterLogService({ logs: vi.fn() });
    const cursor = service.encodeCursor(42);
    expect(service.decodeCursor(cursor)).toBe(42);
    expect(service.decodeCursor(undefined)).toBe(0);
    expect(service.decodeCursor('')).toBe(0);
    expect(service.decodeCursor('invalid-cursor')).toBe(0);
    expect(
      service.decodeCursor(Buffer.from('v2:10').toString('base64url')),
    ).toBe(0);
    expect(
      service.decodeCursor(Buffer.from('v1:-5').toString('base64url')),
    ).toBe(0);
  });

  it('paginates logs and provides nextCursor when more entries exist', async () => {
    const mockLogs = vi.fn().mockResolvedValue({
      entries: [
        { time: 1000, text: 'log-1' },
        { time: 999, text: 'log-2' },
      ],
      total: 5,
    });
    const service = new CharacterLogService({ logs: mockLogs });

    const result = await service.getLogsPage('char-1', {
      limit: 2,
      cursor: service.encodeCursor(1),
    });

    expect(mockLogs).toHaveBeenCalledWith('char-1', 2, 1);
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.nextCursor).toBe(service.encodeCursor(3));
  });

  it('omits nextCursor when the page reaches or exceeds total', async () => {
    const mockLogs = vi.fn().mockResolvedValue({
      entries: [{ time: 1000, text: 'log-final' }],
      total: 3,
    });
    const service = new CharacterLogService({ logs: mockLogs });

    const result = await service.getLogsPage('char-1', {
      limit: 10,
      cursor: service.encodeCursor(2),
    });

    expect(result.nextCursor).toBeUndefined();
  });

  it('clamps limit to valid range and uses default for invalid values', async () => {
    const mockLogs = vi.fn().mockResolvedValue({ entries: [], total: 0 });
    const service = new CharacterLogService({ logs: mockLogs });

    await service.getLogsPage('char-1', { limit: 0 });
    expect(mockLogs).toHaveBeenLastCalledWith('char-1', 1, 0);

    await service.getLogsPage('char-1', { limit: 9999 });
    expect(mockLogs).toHaveBeenLastCalledWith(
      'char-1',
      AI_CHARACTER_LOG_MAX_PAGE_SIZE,
      0,
    );

    await service.getLogsPage('char-1', { limit: 'invalid' });
    expect(mockLogs).toHaveBeenLastCalledWith(
      'char-1',
      AI_CHARACTER_LOG_PAGE_SIZE,
      0,
    );

    await service.getLogsPage('char-1', {});
    expect(mockLogs).toHaveBeenLastCalledWith(
      'char-1',
      AI_CHARACTER_LOG_PAGE_SIZE,
      0,
    );
  });
});
