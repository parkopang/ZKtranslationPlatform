import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function encryptionKey(): Buffer | null {
  const configured = process.env.PII_ENCRYPTION_KEY?.trim();
  if (!configured) return null;
  // Accept a 32-byte hex key or derive a stable 32-byte key from a secret
  // supplied by the deployment secret manager.
  if (/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  return crypto.createHash('sha256').update(configured).digest();
}

export function encryptPii(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith(PREFIX)) return value;
  const key = encryptionKey();
  if (!key) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

export function decryptPii(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) return value;
  const key = encryptionKey();
  if (!key) throw new Error('PII_ENCRYPTION_KEY is required to read encrypted personal data');
  const payload = Buffer.from(value.slice(PREFIX.length), 'base64url');
  if (payload.length < 28) throw new Error('Encrypted personal data is invalid');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function hasPiiEncryptionKey(): boolean {
  return Boolean(encryptionKey());
}

export function hashPii(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = encryptionKey();
  // A keyed digest prevents an operator with only the database dump from
  // enumerating phone numbers. Development without a key still gets a
  // deterministic digest; production refuses to start without the key.
  return crypto.createHmac('sha256', key || Buffer.from('development-only-pii-hash')).update(value).digest('hex');
}
