import type { Visibility } from '@pcu/contracts';
export const visibilityLabels: Record<Visibility, string> = {
 PUBLIC: '전체 공개', AUTHENTICATED: '로그인 사용자', STAFF: '운영자·관리자',
};
export const visibilityRank: Record<Visibility, number> = { PUBLIC: 0, AUTHENTICATED: 1, STAFF: 2 };

