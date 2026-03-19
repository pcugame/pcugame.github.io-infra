const HANGUL_INITIAL = [
  'g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h',
];
const HANGUL_MEDIAL = [
  'a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i',
];
const HANGUL_FINAL = [
  '','k','kk','ks','n','nj','nh','d','l','lk','lm','lb','ls','lt','lp','lh','m','b','bs','s','ss','ng','j','ch','k','t','p','h',
];

function romanizeHangul(text: string): string {
  let result = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const offset = code - 0xac00;
      const initial = Math.floor(offset / (21 * 28));
      const medial = Math.floor((offset % (21 * 28)) / 28);
      const final = offset % 28;
      result += (HANGUL_INITIAL[initial] ?? '') + (HANGUL_MEDIAL[medial] ?? '') + (HANGUL_FINAL[final] ?? '');
    } else {
      result += char;
    }
  }
  return result;
}

export function toSlug(title: string): string {
  const romanized = romanizeHangul(title);
  return romanized
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'untitled';
}
