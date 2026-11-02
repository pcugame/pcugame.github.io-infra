import { useState } from 'react';
import type { Award } from '@pcu/contracts';

export function AwardImage({ award }: { award: Award }) {
 const src = award.imageUrl ?? (award.builtinKey ? `${import.meta.env.BASE_URL}awards/${award.builtinKey}.svg` : undefined);
 const [failedSrc, setFailedSrc] = useState<string>();
 return <span className="award-badge">{src && src !== failedSrc && <img key={src} src={src} alt="" onError={() => setFailedSrc(src)} />}<span>{award.name}</span></span>;
}
