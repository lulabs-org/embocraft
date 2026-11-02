import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secrets';

describe('secrets encryption', () => {
  it('returns plaintext if no encryption key is set', () => {
    delete process.env.DATA_ENCRYPTION_KEY;

    expect(encryptSecret('my-secret-key')).toBe('my-secret-key');
    expect(decryptSecret('my-secret-key')).toBe('my-secret-key');
  });

  it('encrypts and decrypts secret when key is set', () => {
    process.env.DATA_ENCRYPTION_KEY = 'test-encryption-key-for-database';

    const secret = 'sk-1234567890abcdef';
    const encrypted = encryptSecret(secret);
    expect(encrypted).toMatch(/^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(encrypted).not.toBe(secret);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('is idempotent on already encrypted values', () => {
    process.env.DATA_ENCRYPTION_KEY = 'test-encryption-key-for-database';
    const secret = 'sk-secret';
    const encrypted = encryptSecret(secret);
    expect(encryptSecret(encrypted)).toBe(encrypted);
  });
});
