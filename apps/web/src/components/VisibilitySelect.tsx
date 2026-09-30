import type { SelectHTMLAttributes } from 'react';
import type { Visibility } from '@pcu/contracts';
import { env } from '../lib/env';

import { visibilityLabels, visibilityRank } from '../lib/visibility';

export function VisibilitySelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
 if (!env.VISIBILITY_CONTROLS_ENABLED) return null;
 return <select aria-label="공개 범위" {...props}>
  <option value="" disabled>공개 범위를 선택하세요</option>
  {Object.entries(visibilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
 </select>;
}

export function VisibilityNotice({ visibility, exhibitionVisibility }: { visibility?: Visibility; exhibitionVisibility?: Visibility }) {
 if (!env.VISIBILITY_CONTROLS_ENABLED || !exhibitionVisibility || visibilityRank[visibility ?? 'PUBLIC'] >= visibilityRank[exhibitionVisibility]) return null;
 return <p className="field-hint">작품의 실제 공개 범위는 전시회의 공개 범위({visibilityLabels[exhibitionVisibility]})를 따릅니다.</p>;
}
