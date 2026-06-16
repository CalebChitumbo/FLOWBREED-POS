/**
 * Service container. Assembled once on MAIN startup against the live DB and stored
 * as a process singleton that IPC handlers read via `getServices()`. Tests build
 * their own instances directly (see tests/unit/services).
 */
import type { DB } from '../db/connection';
import { SessionManager } from '../security/session';
import { ConfigService } from './config-service';
import { AuditService } from './audit-service';
import { OutboxService } from './outbox-service';
import { UserService } from './user-service';
import { AuthService } from './auth-service';

export interface Services {
  sessions: SessionManager;
  config: ConfigService;
  audit: AuditService;
  outbox: OutboxService;
  users: UserService;
  auth: AuthService;
}

export function buildServices(db: DB): Services {
  const sessions = new SessionManager();
  const config = new ConfigService(db);
  const audit = new AuditService(db);
  const outbox = new OutboxService(db);
  const users = new UserService(db, audit, outbox);
  const auth = new AuthService(users, sessions, audit);
  return { sessions, config, audit, outbox, users, auth };
}

let services: Services | null = null;

export function initServices(db: DB): Services {
  services = buildServices(db);
  return services;
}

export function getServices(): Services {
  if (!services) throw new Error('Services not initialised — call initServices() first');
  return services;
}
