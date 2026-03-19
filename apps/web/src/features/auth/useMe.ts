// ── 현재 로그인 상태 조회 훅 ─────────────────────────────────

import { useQuery } from '@tanstack/react-query';
import { authApi } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import type { AuthUser, MeResponse } from '../../contracts';

export function useMe() {
  const query = useQuery({
    queryKey: queryKeys.me,
    queryFn: authApi.me,
    staleTime: 1000 * 60 * 5, // 5분
    retry: false,
  });

  const data: MeResponse | undefined = query.data;

  const isAuthenticated = data?.authenticated === true;
  const user: AuthUser | null =
    data?.authenticated === true ? data.user : null;

  return {
    ...query,
    isAuthenticated,
    user,
  };
}
