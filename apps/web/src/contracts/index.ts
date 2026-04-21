// API 응답/요청 타입은 packages/contracts (@pcu/contracts) 에서 import.
// 여기서는 (a) 공유 타입 re-export + (b) Web-로컬 폼 스키마(Zod v4) 만 둔다.

export * from '@pcu/contracts';
export * from './schemas';

// 폼 옵션 등 런타임 배열은 Web에서 필요한 곳에서 따로 정의한다.
// (예: USER_ROLES = ['USER', 'OPERATOR', 'ADMIN'] as const)
