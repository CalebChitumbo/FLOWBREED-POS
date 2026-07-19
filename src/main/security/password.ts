/**
 * Password hashing (NS-01). Uses bcrypt (bcryptjs, pure JavaScript) so there is no
 * native module to compile against the older Electron 22 runtime required for
 * Windows 7 support. Verification never throws — a malformed/wrong hash returns false.
 */
import bcrypt from 'bcryptjs';

const ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
