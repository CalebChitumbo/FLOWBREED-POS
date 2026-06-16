import { randomUUID } from 'node:crypto';

/** Client-generated stable id used as both the SQLite PK and the cloud doc id. */
export function newId(): string {
  return randomUUID();
}
