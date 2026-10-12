/** The trusted shell is the only API-origin session control surface. */
export function isPlayControlPath(method: string, url: string): boolean {
  return (
    method === "POST" &&
    /^\/api\/webgl-play\/sessions(?:\/[a-f0-9-]{36}\/(?:renew|close|diagnostics))?$/.test(
      url.split("?")[0]!,
    )
  );
}
export function isTrustedPlaySource(
  headers: Record<string, string | string[] | undefined>,
  apiUrl: string,
): boolean {
  return (
    headers.origin === new URL(apiUrl).origin &&
    headers["sec-fetch-site"] === "same-origin" &&
    (headers["sec-fetch-mode"] === "cors" ||
      headers["sec-fetch-mode"] === "same-origin") &&
    typeof headers["content-type"] === "string" &&
    /^application\/json(?:\s*;|$)/i.test(headers["content-type"])
  );
}

/** Only this POST route accepts a session-scoped report capability instead of CSRF. */
export function isPlayReportPath(method: string, url: string): boolean {
 return method === 'POST' && /^\/api\/webgl-play\/reports\/[a-f0-9]{64}$/.test(url);
}
