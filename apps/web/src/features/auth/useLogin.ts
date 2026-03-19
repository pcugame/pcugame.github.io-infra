// ── Google 로그인 mutation 훅 ────────────────────────────────

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authApi } from '../../lib/api';
import { queryKeys } from '../../lib/query';

export function useLogin() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (credential: string) => authApi.loginWithGoogle(credential),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}
