import { useId } from 'react';
import { ExternalLinksSchema, type ExternalLink } from '@pcu/contracts';

interface Props {
	value: ExternalLink[];
	onChange: (links: ExternalLink[]) => void;
	disabled?: boolean;
	showErrors?: boolean;
}

export function ExternalLinksFieldset({ value, onChange, disabled = false, showErrors = false }: Props) {
	const id = useId();
	const result = ExternalLinksSchema.safeParse(value);
	const issues = showErrors && !result.success ? result.error.issues : [];
	const update = (index: number, patch: Partial<ExternalLink>) => {
		onChange(value.map((link, i) => i === index ? { ...link, ...patch } : link));
	};

	return (
		<fieldset disabled={disabled}>
			<legend>외부 링크</legend>
			<p className="field-hint">GitHub, 게임 소개, 다운로드 등 원하는 링크를 최대 20개 추가하세요.</p>
			{value.map((link, index) => (
				<div className="external-link-row" key={`${id}-${index}`}>
					{(['label', 'url'] as const).map((field) => {
						const errors = issues.filter((issue) => issue.path[0] === index && issue.path[1] === field);
						const inputId = `${id}-${index}-${field}`;
						return (
							<div className="form-field" key={field}>
								<label htmlFor={inputId}>{field === 'label' ? '링크 이름' : 'URL'}</label>
								<input
									id={inputId}
									aria-label={`외부 링크 ${index + 1} ${field === 'label' ? '이름' : 'URL'}`}
									aria-invalid={errors.length > 0}
									aria-describedby={errors.length ? `${inputId}-error` : undefined}
									type={field === 'url' ? 'url' : 'text'}
									placeholder={field === 'url' ? 'https://' : undefined}
									value={link[field]}
									maxLength={field === 'label' ? 80 : 2000}
									onChange={(event) => update(index, { [field]: event.target.value })}
								/>
								{errors.length > 0 && <p id={`${inputId}-error`} className="field-error" role="alert">{errors.map((issue) => issue.message).join(' · ')}</p>}
							</div>
						);
					})}
					<button
						type="button"
						className="btn btn--danger btn--small"
						aria-label={`외부 링크 ${index + 1} 삭제`}
						onClick={() => onChange(value.filter((_, i) => i !== index))}
					>삭제</button>
				</div>
			))}
			{issues.filter((issue) => issue.path.length === 0).map((issue, index) => (
				<p className="field-error" role="alert" key={index}>{issue.message}</p>
			))}
			<button
				type="button"
				className="btn btn--secondary btn--small"
				disabled={disabled || value.length >= 20}
				onClick={() => onChange([...value, { label: '', url: '' }])}
			>링크 추가</button>
		</fieldset>
	);
}
