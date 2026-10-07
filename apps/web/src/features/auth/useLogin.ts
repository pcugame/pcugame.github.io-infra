// ── Google 로그인 mutation 훅 ────────────────────────────────

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi } from '../../lib/api';
import { SessionNotEstablishedError, SessionVerificationError } from './session-errors';
import type { DevAuthErrorScenario, UserRole } from '../../contracts';
import { queryKeys, invalidateVisibilityQueries } from '../../lib/query';

export type LoginInput =
  | string
  | { type: 'dev-role'; role: UserRole }
  | { type: 'dev-error'; scenario: DevAuthErrorScenario };

export function useLogin() {
  const qc = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async (input: LoginInput) => {
      if (typeof input === 'string') await authApi.loginWithGoogle(input);
      else if (input.type === 'dev-role') await authApi.loginWithDevRole(input.role);
      else await authApi.simulateDevLoginError(input.scenario);

      // A successful login response does not prove the browser accepted its cookie.
      // Cancel an older anonymous lookup before publishing the verified session.
      await qc.cancelQueries({ queryKey: queryKeys.me });
      let session;
      try {
        session = await authApi.me();
      } catch {
        throw new SessionVerificationError();
      }
      qc.setQueryData(queryKeys.me, session);
      if (!session.authenticated) throw new SessionNotEstablishedError();
      return session;
    },
    onSuccess: () => {
      void invalidateVisibilityQueries(qc);
    },
  });
}
