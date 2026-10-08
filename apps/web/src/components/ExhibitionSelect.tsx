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
  const richOptions = typeof CSS !== 'undefined'
    && CSS.supports('appearance', 'base-select')
    && CSS.supports('selector(::picker(select))');
  return <SelectControl {...props} value={value ?? ''} onChange={event => onChange(Number(event.target.value))}>
    <option value="" disabled>전시회를 선택하세요</option>
    {items.map(item => {
      const locked = !(item.isModificationEnabled ?? item.isUploadEnabled);
      const label = `${item.year} ${item.title ?? ''}${locked ? ' 업로드 잠김' : ''}`;
      return <option key={item.id} value={item.id} aria-label={label}>
        {richOptions ? <span className="exhibition-select__content">
          <span className="exhibition-select__year">{item.year}</span>
          {' '}
          <span className={`exhibition-select__title${locked ? '' : ' exhibition-select__title--active'}`}>{item.title ?? ''}</span>
          {locked && <>{' '}<span className="exhibition-select__lock-pill">업로드 잠김</span></>}
        </span> : label}
      </option>;
    })}
  </SelectControl>;
}
