import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { env } from '../config/env';

const PREFIX = 'enc:v1:';

function getEncryptionKey(): Buffer | undefined {
  const secret = env.encryptionSecret();
  if (!secret) return undefined;
  return createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a secret value with AES-256-GCM.
 * If no encryption key is configured or value is empty, the value is returned unmodified.
 */
export function encryptSecret(plainText: string): string {
  if (!plainText || plainText.startsWith(PREFIX)) return plainText;
  const key = getEncryptionKey();
  if (!key) return plainText;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an AES-256-GCM encrypted secret.
 * If value does not start with prefix or no key is configured, returns raw value.
 */
export function decryptSecret(cipherText: string): string {
  if (!cipherText || !cipherText.startsWith(PREFIX)) return cipherText;
  const key = getEncryptionKey();
  if (!key) return cipherText;

  try {
    const parts = cipherText.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return cipherText;
    const [ivHex, tagHex, dataHex] = parts;

    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Return original cipherText if decryption fails (e.g. wrong key)
    return cipherText;
  }
}
