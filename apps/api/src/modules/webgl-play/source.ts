/** The trusted shell is the only API-origin session control surface. */
export function isPlayControlPath(method: string, url: string): boolean {
  return (
    method === "POST" &&
    /^\/api\/webgl-play\/sessions(?:\/[a-f0-9-]{36}\/(?:renew|close))?$/.test(
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
