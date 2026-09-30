// ── 전역 Provider 래퍼 ───────────────────────────────────────

import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../lib/query';
import { FileAccessRenewal } from '../lib/query/FileAccessRenewal';
import { UploadProvider } from '../lib/upload';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <FileAccessRenewal />
      <UploadProvider>{children}</UploadProvider>
    </QueryClientProvider>
  );
}
