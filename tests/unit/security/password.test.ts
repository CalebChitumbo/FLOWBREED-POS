import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/main/security/password';

describe('password hashing (argon2id)', () => {
  it('produces an argon2id hash that is not the plaintext', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(hash).not.toBe('s3cret-pass');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies the correct password', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword(hash, 'correct horse')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword(hash, 'wrong horse')).toBe(false);
  });

  it('returns false (never throws) for a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
  });
});
