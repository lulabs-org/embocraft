import { describe, expect, it, vi } from 'vitest';
import { WhisperModelCatalog, listWhisperModels } from './whisper.models';

describe('WhisperModelCatalog', () => {
  it('requests models with automatic-speech-recognition task filter', async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'Systran/faster-whisper-small',
                task: 'automatic-speech-recognition',
                language: ['zh', 'en'],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const catalog = new WhisperModelCatalog(
      { baseUrl: 'http://localhost:8000/v1', apiKey: 'test-key' },
      mockFetch as unknown as typeof fetch,
    );

    const models = await catalog.list();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('Systran/faster-whisper-small');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/v1/models?task=automatic-speech-recognition',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-key' },
      }),
    );
  });

  it('helper listWhisperModels function works identically', async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: [] }),
          { status: 200 },
        ),
      ),
    );

    const models = await listWhisperModels(
      { baseUrl: 'http://localhost:8000/v1' },
      undefined,
      mockFetch as unknown as typeof fetch,
    );
    expect(models).toEqual([]);
  });
});
