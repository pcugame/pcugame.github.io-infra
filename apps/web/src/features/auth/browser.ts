export function isMacSafari(userAgent: string): boolean {
  return /Macintosh/.test(userAgent)
    && /Version\/[\d.]+.*Safari\//.test(userAgent)
    && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Android|iPhone|iPad|Mobile/.test(userAgent);
}

