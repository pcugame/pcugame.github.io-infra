import crypto from 'node:crypto';
import { env } from '../config/env.js';

export function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function sessionExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + env().SESSION_TTL_DAYS);
  return d;
}
