/**
 * Password hashing with argon2id (NS-01). Parameters tuned for an interactive
 * desktop login. Verification never throws — a malformed/wrong hash returns false.
 */
import argon2 from 'argon2';

const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
