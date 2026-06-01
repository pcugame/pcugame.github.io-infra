// ── Google 로그인 mutation 훅 ────────────────────────────────

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi } from '../../lib/api';
import type { DevAuthErrorScenario, UserRole } from '../../contracts';
import { queryKeys } from '../../lib/query';

export type LoginInput =
  | string
  | { type: 'dev-role'; role: UserRole }
  | { type: 'dev-error'; scenario: DevAuthErrorScenario };

export function useLogin() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: LoginInput) => {
      if (typeof input === 'string') return authApi.loginWithGoogle(input);
      if (input.type === 'dev-role') return authApi.loginWithDevRole(input.role);
      return authApi.simulateDevLoginError(input.scenario);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}
