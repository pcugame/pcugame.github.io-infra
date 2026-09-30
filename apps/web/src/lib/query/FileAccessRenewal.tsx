import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { collectFileTokens, type FileAccessResponse } from '../api/file-access';
import { invalidateVisibilityQueries } from './visibility';

/** Renew capabilities used by mounted screens without changing the WebGL iframe URL. */
export function FileAccessRenewal() {
 const client = useQueryClient();
 useEffect(() => {
  let renewing = false;
  let disposed = false;
  async function renew() {
   if (renewing || disposed || document.visibilityState === 'hidden') return;
   renewing = true;
   const tokens = new Set<string>();
   client.getQueryCache().findAll().filter((query) => query.isActive()).forEach((query) => {
    collectFileTokens(query.state.data).forEach((token) => tokens.add(token));
   });
   try {
    await Promise.all([...tokens].map((token) => api.post<FileAccessResponse>(`/api/file-access/${encodeURIComponent(token)}/renew`)));
   } catch {
    if (!disposed) await invalidateVisibilityQueries(client);
   } finally { renewing = false; }
  }
  const timer = window.setInterval(() => void renew(), 30_000);
  const visible = () => { if (document.visibilityState === 'visible') void renew(); };
  document.addEventListener('visibilitychange', visible);
  return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
 }, [client]);
 return null;
}
