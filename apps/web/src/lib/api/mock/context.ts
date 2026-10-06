import type { AdminExhibitionItem, AdminProjectDetail } from '../../../contracts';
import type { ProjectChangeDetail, WebglNetworkRequest } from '@pcu/contracts';
import { MOCK_ADMIN_YEARS } from './data';
import { createProjectFixtures } from './fixtures';
import type { MockSubmissionRecord, MockUploadSession } from './uploads';

export const UNHANDLED = Symbol('unhandled mock route');
export class MockHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = 'MockHttpError'; this.status = status; this.code = code;
  }
}
export type MockRequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };
export type MockUserSelection = 'anonymous' | 'owner' | 'participant' | 'other' | 'OPERATOR' | 'ADMIN';
export type MockUser = { id: number; name: string; email: string; role: 'ADMIN' | 'OPERATOR' | 'USER'; studentId?: string };
export const MOCK_USERS: Record<Exclude<MockUserSelection, 'anonymous'>, MockUser> = {
  ADMIN: { id: 1, name: '관리자', email: 'admin@test.pcu.ac.kr', role: 'ADMIN' },
  OPERATOR: { id: 2, name: '운영자', email: 'operator@test.pcu.ac.kr', role: 'OPERATOR' },
  owner: { id: 3, name: '학생', email: '2088099@test.pcu.ac.kr', studentId: '2088099', role: 'USER' },
  participant: { id: 4, name: '테스트파트너', email: '2088100@test.pcu.ac.kr', studentId: '2088100', role: 'USER' },
  other: { id: 5, name: '다른 학생', email: '2088101@test.pcu.ac.kr', studentId: '2088101', role: 'USER' },
};
export type MockProject = AdminProjectDetail & {
  exhibitionId: number; createdAt: string; updatedAt: string; createdByUserId: number;
  participantUserIds?: number[]; isChangeRequestDraft?: boolean; version: number; webglNetworkPolicyVersion: number;
};
export type MockFault = { status: number; code: string; message: string; path?: string; method?: string; retryAfter?: string };
export type MockControls = { delayMs: number; fault: MockFault | null; worker: 'auto' | 'paused' | 'fail' };
export type MockBannedIp = { id:number; ip:string; reason:string; createdAt:string; source:'AUTO'|'MANUAL'|'LEGACY'; active:boolean; disabledAt:string|null };
export type MockState = {
  version: 1; revision: number; counters: Record<string, number>; authUser: MockUserSelection; authExpiresAt?: string;
  projects: Record<number, MockProject>; exhibitions: AdminExhibitionItem[];
  submissions: Record<string, MockSubmissionRecord>; sessions: Record<string, MockUploadSession>; changeRequests: Record<string, ProjectChangeDetail & {dueAt?:number}>;
  networkRequests: Record<string, WebglNetworkRequest>; fileTokens: Record<string, unknown>; idempotency: Record<string, unknown>;
  exportJobs: Record<string, unknown>; settings: { maxGameFileMb: number; maxChunkSizeMb: number };
  bannedIps: MockBannedIp[]; controls: MockControls;
};
export interface MockContext {
  state: MockState; readonly user: MockUser | null;
  now(): string; nextId(prefix: string): string; requireUser(): MockUser; requireAdmin(): MockUser;
}
export function createMockContext(state: MockState): MockContext {
  return {
    state,
    get user() { return state.authUser === 'anonymous' || state.authExpiresAt !== undefined && Date.parse(state.authExpiresAt) <= Date.now() ? null : MOCK_USERS[state.authUser]; },
    now: () => new Date().toISOString(),
    nextId(prefix) { state.counters[prefix] = (state.counters[prefix] ?? 0) + 1; return `${prefix}-${state.counters[prefix]}`; },
    requireUser() { if (!this.user) throw new MockHttpError(401, 'UNAUTHORIZED', '로그인이 필요합니다.'); return this.user; },
    requireAdmin() { const user = this.requireUser(); if (user.role === 'USER') throw new MockHttpError(403, 'FORBIDDEN', '권한이 없습니다.'); return user; },
  };
}
function initialUser(): MockUserSelection {
  try { const role = localStorage.getItem('mock-role'); return role === 'USER' ? 'owner' : role === 'OPERATOR' ? 'OPERATOR' : 'ADMIN'; } catch { return 'ADMIN'; }
}
export function createMockState(): MockState {
  const now = new Date().toISOString();
  const projects = createProjectFixtures();
  return { version: 1, revision: 0, counters: {}, authUser: initialUser(), projects,
    exhibitions: cloneMockValue(MOCK_ADMIN_YEARS), submissions: {}, sessions: {}, changeRequests: {}, networkRequests: {},
    fileTokens: {}, idempotency: {}, exportJobs: {}, settings: { maxGameFileMb: 5120, maxChunkSizeMb: 10 },
    bannedIps: [{ id: 1, ip: '203.0.113.42', reason: 'Mock download rate limit exceeded', createdAt: now, source: 'MANUAL', active: true, disabledAt: null }],
    controls: { delayMs: 0, fault: null, worker: 'auto' } };
}
// Keep Blob identity while copying mutable containers, including in jsdom tests.
export function cloneMockValue<T>(value: T): T {
  if (value === null || typeof value !== 'object' || value instanceof Blob) return value;
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, cloneMockValue(item)])) as T;
  if (Array.isArray(value)) return value.map(cloneMockValue) as T;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneMockValue(item)])) as T;
}
