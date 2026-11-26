export function isStaffRole(role?: string) {
  return role === 'ADMIN' || role === 'OPERATOR';
}

export function submissionMode(role?: string) {
  return isStaffRole(role) ? 'admin' : 'user';
}
