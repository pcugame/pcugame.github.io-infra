import type { AdminExhibitionItem } from '../contracts';
import CustomSelect from './CustomSelect';

interface Props {
	id?: string;
	value: number | null;
	onChange: (id: number) => void;
	items: AdminExhibitionItem[];
	disabled?: boolean;
	'aria-invalid'?: boolean;
}

export default function ExhibitionSelect({ items, onChange, ...props }: Props) {
	const renderLabel = (it: AdminExhibitionItem) => (
		<>
			<span className="exhibition-select__year">{it.year}</span>
			<span
				className={
					'exhibition-select__title' +
					((it.isModificationEnabled ?? it.isUploadEnabled) ? ' exhibition-select__title--active' : '')
				}
			>
				{it.title ?? ''}
			</span>
			{!(it.isModificationEnabled ?? it.isUploadEnabled) && (
				<span className="exhibition-select__lock-pill">업로드 잠김</span>
			)}
		</>
	);

	return <CustomSelect {...props} placeholder="전시회를 선택하세요"
		onChange={(value) => onChange(Number(value))}
		items={items.map((item) => ({ value: item.id, label: renderLabel(item), searchText: `${item.year} ${item.title ?? ''}` }))} />;
}
