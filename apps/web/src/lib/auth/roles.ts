import type { UserRole } from '@pcu/contracts';

export function isStaffRole(role?: string) {
  return role === 'ADMIN' || role === 'OPERATOR';
}

export function canUseLab(role?: UserRole) {
  return role === 'ADMIN' || role === 'BETA_TESTER';
}

export function submissionMode(role?: string) {
  return isStaffRole(role) ? 'admin' : 'user';
}
