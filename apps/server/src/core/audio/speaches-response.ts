/** Read a Speaches response with a fixed memory limit and release its reader. */
export async function readSpeachesResponse(
  response: Response,
): Promise<Buffer> {
  if (!response.body) throw Error('shape');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw Error('size');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
