/** Clear browser resume pointers only when their persisted Mock data is discarded. */
export function clearMockBrowserProgress(storage: Storage): void {
  const keys = Array.from({length:storage.length}, (_,i)=>storage.key(i));
  for (const key of keys) if (key && (key.startsWith('pcu.pending-project-submission:') || /^pcu\.direct-(?:asset|image|poster|video|document|attachment)-upload:/.test(key))) storage.removeItem(key);
}
