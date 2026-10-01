import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WebglDisplaySettingsSchema, MAX_WEBGL_DISPLAY_SIZE, type AdminProjectDetail, type WebglDisplaySettings } from '@pcu/contracts';
import { getApiErrorMessage, userProjectApi } from '../../../lib/api';
import { queryKeys } from '../../../lib/query';

interface Props {
	project: AdminProjectDetail;
	isPending: boolean;
	onPendingChange?: (pending: boolean) => void;
}

const draftFrom = (settings: WebglDisplaySettings) => ({
	custom: settings.webglDisplayWidth !== null && settings.webglDisplayHeight !== null,
	width: settings.webglDisplayWidth?.toString() ?? '',
	height: settings.webglDisplayHeight?.toString() ?? '',
});

export function WebglDisplaySettingsForm({ project, isPending, onPendingChange }: Props) {
	const qc = useQueryClient();
	const [baseline, setBaseline] = useState(() => draftFrom({
		webglDisplayWidth: project.webglDisplayWidth ?? null,
		webglDisplayHeight: project.webglDisplayHeight ?? null,
	}));
	const [draft, setDraft] = useState(baseline);
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const disabled = project.canEditWebglDisplay !== true || isPending || saving;
	const dirty = draft.custom !== baseline.custom || draft.width !== baseline.width || draft.height !== baseline.height;
	const prefix = `webgl-display-${project.id}`;
	const edit = (next: typeof draft) => { setDraft(next); setSaved(false); setError(null); };

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (disabled || savingRef.current || !dirty) return;
		const validDigits = /^\d+$/;
		const parsed = WebglDisplaySettingsSchema.safeParse(draft.custom ? {
			webglDisplayWidth: validDigits.test(draft.width) ? Number(draft.width) : NaN,
			webglDisplayHeight: validDigits.test(draft.height) ? Number(draft.height) : NaN,
		} : { webglDisplayWidth: null, webglDisplayHeight: null });
		if (!parsed.success) {
			setError(`가로와 세로를 모두 1~${MAX_WEBGL_DISPLAY_SIZE} 사이의 정수로 입력하세요.`);
			return;
		}
		savingRef.current = true;
		setSaving(true);
		onPendingChange?.(true);
		setError(null);
		try {
			const response = await userProjectApi.setWebglDisplay(project.id, parsed.data);
			const next = draftFrom(response);
			setBaseline(next);
			setDraft(next);
			qc.setQueryData<AdminProjectDetail>(queryKeys.adminProject(project.id), (current) => current ? { ...current, ...response } : current);
			await Promise.all([
				qc.invalidateQueries({ queryKey: queryKeys.projectDetail(project.year, project.slug) }),
				qc.invalidateQueries({ queryKey: queryKeys.projectDetailById(project.id) }),
			]);
			setSaved(true);
		} catch (cause) {
			setError(getApiErrorMessage(cause));
		} finally {
			savingRef.current = false;
			setSaving(false);
			onPendingChange?.(false);
		}
	}

	return (
		<form className="project-form" aria-label="WebGL 표시 크기 설정" onSubmit={submit} noValidate>
			<fieldset disabled={disabled}>
				<legend>WebGL 표시 크기</legend>
				<p className="field-hint">게임을 페이지에 표시할 크기(CSS px)입니다. 화면이 작으면 비율을 유지해 맞춥니다. Unity 게임 내부의 렌더링 해상도는 별도로 설정됩니다.</p>
				<div className="form-field">
					<label htmlFor={`${prefix}-mode`}>표시 크기 설정</label>
					<select id={`${prefix}-mode`} value={draft.custom ? 'custom' : 'default'} onChange={(event) => edit(event.target.value === 'default' ? { custom: false, width: '', height: '' } : { ...draft, custom: true })}>
						<option value="default">기본 표시 크기 사용 (설정 해제)</option>
						<option value="custom">가로·세로 직접 지정</option>
					</select>
				</div>
				<div className="form-field">
					<label htmlFor={`${prefix}-width`}>가로 (CSS px)</label>
					<input id={`${prefix}-width`} type="text" inputMode="numeric" disabled={!draft.custom} value={draft.width} onChange={(event) => edit({ ...draft, width: event.target.value })} />
				</div>
				<div className="form-field">
					<label htmlFor={`${prefix}-height`}>세로 (CSS px)</label>
					<input id={`${prefix}-height`} type="text" inputMode="numeric" disabled={!draft.custom} value={draft.height} onChange={(event) => edit({ ...draft, height: event.target.value })} />
				</div>
				<p className="field-hint">이 설정은 아래 ‘적용’ 버튼과 별도로 저장됩니다. 설정 해제도 ‘표시 크기 저장’을 눌러야 반영됩니다.</p>
				<button className="btn btn--primary" type="submit" disabled={!dirty || disabled}>{saving ? '표시 크기 저장 중…' : '표시 크기 저장'}</button>
			</fieldset>
			{project.canEditWebglDisplay !== true && <p className="field-hint">WebGL 표시 크기를 변경할 권한이 없습니다.</p>}
			{error && <p className="field-error" role="alert">{error}</p>}
			{saving && <p role="status">표시 크기를 저장하고 있습니다…</p>}
			{saved && <p className="success-message" role="status">표시 크기가 저장되었습니다.</p>}
		</form>
	);
}
