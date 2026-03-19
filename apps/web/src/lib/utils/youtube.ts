// ── YouTube URL → embed URL 변환 ─────────────────────────────

/**
 * YouTube 일반 URL을 embed URL로 변환한다.
 * 이미 embed 형태이거나 변환 불가능하면 null 반환.
 */
export function toYouTubeEmbedUrl(url: string | undefined | null): string | null {
  if (!url) return null;

  // 이미 embed URL
  if (url.includes('/embed/')) return url;

  try {
    const parsed = new URL(url);

    // https://www.youtube.com/watch?v=VIDEO_ID
    if (parsed.hostname.includes('youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) return `https://www.youtube.com/embed/${videoId}`;
    }

    // https://youtu.be/VIDEO_ID
    if (parsed.hostname === 'youtu.be') {
      const videoId = parsed.pathname.slice(1);
      if (videoId) return `https://www.youtube.com/embed/${videoId}`;
    }
  } catch {
    // 유효하지 않은 URL
  }

  return null;
}
