/** Serialized resources may be absolute URLs or API-relative download paths. */
export function resolveApiResourceUrl(value: string, apiBaseUrl: string): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${apiBaseUrl.replace(/\/$/, '')}/${value.replace(/^\//, '')}`;
}
