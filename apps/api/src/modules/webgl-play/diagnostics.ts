/** Discard report bodies immediately after extracting bounded, non-sensitive fields. */
export function sanitizeConnectionReport(body: unknown): { origin: string; directive: string } | null {
 if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
 const report = (body as Record<string, unknown>)['csp-report'];
 if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
 const fields = report as Record<string, unknown>;
 const directive = fields['effective-directive'] ?? fields['violated-directive'];
 // Other directives can carry inline/code information and aren't connection diagnostics.
 if (directive !== 'connect-src' || typeof fields['blocked-uri'] !== 'string') return null;
 try {
  const url = new URL(fields['blocked-uri']);
  if (!['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol) || url.origin.length > 512) return null;
  return { origin: url.origin, directive };
 } catch { return null; }
}
