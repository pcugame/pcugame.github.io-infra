import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { ExternalLinksSchema, type ExternalLink, type ExternalLinkService } from '@pcu/contracts';
import { externalLinkApi } from '../../lib/api/external-links';
import { ExternalLinkIcon } from './ExternalLinkIcon';

interface Props {
	value: ExternalLink[];
	onChange: (links: ExternalLink[]) => void;
	disabled?: boolean;
	showErrors?: boolean;
}

export function ExternalLinksFieldset({ value, onChange, disabled = false, showErrors = false }: Props) {
	const id = useId();
	const linksRef = useRef(value);
	const onChangeRef = useRef(onChange);
	const resolutionsRef = useRef(new Map<string, Promise<{ service: ExternalLinkService | null }>>());
	const controllerRef = useRef(new AbortController());
	useEffect(() => {
		const controller = new AbortController();
		controllerRef.current = controller;
		return () => controller.abort();
	}, []);
	useLayoutEffect(() => { linksRef.current = value; onChangeRef.current = onChange; });
	const urls = JSON.stringify(value.map((link) => link.url));
	useEffect(() => {
		if (disabled) return;
		let active = true;
		const timers = (JSON.parse(urls) as string[]).map((url, index) => {
			try { if (!['https:', 'http:'].includes(new URL(url).protocol)) return; } catch { return; }
			return setTimeout(() => {
				let pending = resolutionsRef.current.get(url);
				if (!pending) {
					pending = externalLinkApi.resolve(url, controllerRef.current.signal).catch((error: unknown) => {
						resolutionsRef.current.delete(url);
						throw error;
					});
					resolutionsRef.current.set(url, pending);
					if (resolutionsRef.current.size > 100) resolutionsRef.current.delete(resolutionsRef.current.keys().next().value!);
				}
				void pending.then(({ service }) => {
					const current = linksRef.current[index];
					if (!active || !current || current.url !== url || current.service === (service ?? undefined)) return;
					const links = linksRef.current.map((link, i) => i === index ? { ...link, service: service ?? undefined } : link);
					linksRef.current = links;
					onChangeRef.current(links);
				}).catch(() => { /* Keep the local URL logo if resolution is unavailable. */ });
			}, 500);
		});
		return () => { active = false; timers.forEach((timer) => clearTimeout(timer)); };
	}, [urls, disabled]);
	const result = ExternalLinksSchema.safeParse(value);
	const issues = showErrors && !result.success ? result.error.issues : [];
	const change = (links: ExternalLink[]) => {
		linksRef.current = links;
		onChange(links);
	};
	// Show an empty first row without adding invalid data or marking the form dirty.
	const displayedLinks = value.length ? value : [{ label: '', url: '' }];
	const update = (index: number, patch: Partial<ExternalLink>) => {
		const next = displayedLinks.map((link, i) => i === index ? { ...link, ...('url' in patch ? { service: undefined } : {}), ...patch } : link);
		change(next.length === 1 && !next[0].label && !next[0].url ? [] : next);
	};

	return (
		<fieldset disabled={disabled} className="project-external-links">
			<legend>외부 링크</legend>
			<p className="field-hint">GitHub, 게임 소개, 다운로드 등 원하는 링크를 최대 20개 추가하세요.</p>
			{displayedLinks.map((link, index) => (
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
					{value.length > 0 && <button
						type="button"
						className="btn btn--danger btn--small"
						aria-label={`외부 링크 ${index + 1} 삭제`}
						onClick={() => change(value.filter((_, i) => i !== index))}
					>삭제</button>}
					{(link.label || link.url) && <div className="external-link-row__preview"><ExternalLinkIcon url={link.url} service={link.service} /><span>{link.label || '링크 미리보기'}</span></div>}
				</div>
			))}
			{issues.filter((issue) => issue.path.length === 0).map((issue, index) => (
				<p className="field-error" role="alert" key={index}>{issue.message}</p>
			))}
			<button
				type="button"
				className="btn btn--secondary btn--small"
				disabled={disabled || value.length >= 20}
				onClick={() => change([...displayedLinks, { label: '', url: '' }])}
			>링크 추가</button>
		</fieldset>
	);
}
