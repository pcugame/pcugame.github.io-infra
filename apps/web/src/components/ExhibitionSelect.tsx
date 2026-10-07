import type { AdminExhibitionItem } from '../contracts';
import { SelectControl } from './ui/SelectControl';

interface Props {
	id?: string;
	value: number | null;
	onChange: (id: number) => void;
	items: AdminExhibitionItem[];
	disabled?: boolean;
	'aria-invalid'?: boolean;
}

export default function ExhibitionSelect({ items, onChange, value, ...props }: Props) {
  return <SelectControl {...props} value={value ?? ''} onChange={event => onChange(Number(event.target.value))}>
    <option value="" disabled>전시회를 선택하세요</option>
    {items.map(item => <option key={item.id} value={item.id}>
      {item.year} · {item.title ?? ''}{!(item.isModificationEnabled ?? item.isUploadEnabled) ? ' · 업로드 잠김' : ''}
    </option>)}
  </SelectControl>;
}
