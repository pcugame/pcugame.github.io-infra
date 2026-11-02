import type { Award } from '@pcu/contracts';

export const laurelIcons = [
  { key: 'laurel-gold', label: '골드', color: '#f1c46c' },
  { key: 'laurel-silver', label: '실버 블루', color: '#ced9e7' },
  { key: 'laurel-bronze', label: '브론즈', color: '#e0ac7a' },
  { key: 'laurel-slate', label: '슬레이트', color: '#b8bed0' },
] as const satisfies readonly { key: NonNullable<Award['builtinKey']>; label: string; color: string }[];
