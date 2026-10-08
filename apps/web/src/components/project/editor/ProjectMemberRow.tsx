import { useId, type ComponentProps, type ReactNode } from 'react';

export function ProjectMemberRow({ index, name, studentId, nameError, studentIdError, actions }: {
	index: number; name: ComponentProps<'input'>; studentId: ComponentProps<'input'>;
	nameError?: string; studentIdError?: string; actions?: ReactNode;
}) {
	const id = useId();
	return <div className="member-row">
		{([{ key: 'name', label: '이름', props: name, error: nameError }, { key: 'studentId', label: '학번', props: studentId, error: studentIdError }]).map(field => <div className="form-field" key={field.key}>
			<label className={index > 0 ? 'sr-only' : undefined} htmlFor={`${id}-${field.key}`}>{field.label}</label>
			<input type="text" {...field.props} id={`${id}-${field.key}`} aria-required="true" aria-invalid={!!field.error} aria-describedby={field.error ? `${id}-${field.key}-error` : undefined} />
			{field.error && <span id={`${id}-${field.key}-error`} className="field-error" role="alert">{field.error}</span>}
		</div>)}
		{actions}
	</div>;
}
