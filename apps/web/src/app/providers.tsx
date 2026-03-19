// ── 전역 Provider 래퍼 ───────────────────────────────────────

import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../lib/query';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
