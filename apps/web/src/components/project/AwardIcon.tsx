import { useState } from 'react';
import { IconLaurelWreath } from '@tabler/icons-react';
import type { Award } from '@pcu/contracts';
import { laurelIcons } from './awardIcons';

export function AwardIcon({ award, className }: { award: Award; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const laurel = laurelIcons.find(icon => icon.key === award.builtinKey);
  if (laurel) return <IconLaurelWreath className={className} color={laurel.color} aria-hidden="true" focusable="false" />;
  const src = award.imageUrl ?? (award.builtinKey ? `${import.meta.env.BASE_URL}awards/${award.builtinKey}.svg` : undefined);
  if (!src || src === failedSrc) return null;
  return <img key={src} src={src} className={className} alt="" onError={() => setFailedSrc(src)} />;
}
