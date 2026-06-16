/** Key-value settings backed by app_config (NM-02: config not hardcoded). */
import type { DB } from '../db/connection';

export class ConfigService {
  constructor(private readonly db: DB) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getNumber(key: string, fallback: number): number {
    const raw = this.get(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }
}
