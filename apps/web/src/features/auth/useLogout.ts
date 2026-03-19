// ── 로그아웃 mutation 훅 ─────────────────────────────────────

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../../lib/api';
import { queryKeys } from '../../lib/query';

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      qc.setQueryData(queryKeys.me, { authenticated: false });
      qc.clear();
      navigate('/login');
    },
  });
}
