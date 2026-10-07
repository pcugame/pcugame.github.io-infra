import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import type { Visibility } from '@pcu/contracts';
import { env } from '../lib/env';
import { SelectControl } from './ui/SelectControl';
import { visibilityLabels, visibilityRank } from '../lib/visibility';

export const VisibilitySelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function VisibilitySelect({ className, value, defaultValue, ...props }, ref) {
  if (!env.VISIBILITY_CONTROLS_ENABLED) return null;
  return <SelectControl
    {...props}
    ref={ref}
    className={['visibility-select', className].filter(Boolean).join(' ')}
    aria-label={props['aria-label'] ?? (props['aria-labelledby'] ? undefined : '공개 범위')}
    value={value}
    defaultValue={value === undefined ? defaultValue ?? '' : undefined}
  >
    <option value="" disabled>공개 범위를 선택하세요</option>
    {Object.entries(visibilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
  </SelectControl>;
});

export function VisibilityNotice({ visibility, exhibitionVisibility }: { visibility?: Visibility; exhibitionVisibility?: Visibility }) {
	if (!env.VISIBILITY_CONTROLS_ENABLED || !exhibitionVisibility || visibilityRank[visibility ?? 'PUBLIC'] >= visibilityRank[exhibitionVisibility]) return null;
	return <p className="field-hint">작품의 실제 공개 범위는 전시회의 공개 범위({visibilityLabels[exhibitionVisibility]})를 따릅니다.</p>;
}
