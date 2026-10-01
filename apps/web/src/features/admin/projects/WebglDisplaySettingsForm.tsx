import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { WebglDisplaySettingsSchema, MAX_WEBGL_DISPLAY_SIZE, type AdminProjectDetail, type WebglDisplaySettings } from '@pcu/contracts';
import { getApiErrorMessage, userProjectApi } from '../../../lib/api';
import { queryKeys, useViewerKey } from '../../../lib/query';

interface Props {
	project: AdminProjectDetail;
	isPending: boolean;
	onPendingChange?: (pending: boolean) => void;
}

const draftFrom = (settings: WebglDisplaySettings) => ({
	mode: settings.webglDisplayMode ?? (settings.webglDisplayWidth != null && settings.webglDisplayHeight != null ? 'manual' : 'legacy'),
	width: settings.webglDisplayWidth?.toString() ?? '',
	height: settings.webglDisplayHeight?.toString() ?? '',
});

export function WebglDisplaySettingsForm({ project, isPending, onPendingChange }: Props) {
	const qc = useQueryClient();
	const viewerKey = useViewerKey();
	const settingsKey = viewerKey(['webgl-display', project.id, project.webglDeployment?.id] as const);
	const { data: settings, isLoading: loadingAnalysis, error: analysisError } = useQuery({
		queryKey: settingsKey,
		queryFn: () => userProjectApi.getWebglDisplay(project.id),
		retry: (failures, error) => !(error && 'status' in error && error.status === 403) && failures < 2,
	});
	const analysis = settings?.analysis;
	const analysisForbidden = analysisError && 'status' in analysisError && analysisError.status === 403;
	const [baseline, setBaseline] = useState(() => draftFrom({
		webglDisplayMode: project.webglDisplayMode,
		webglDisplayWidth: project.webglDisplayWidth ?? null,
		webglDisplayHeight: project.webglDisplayHeight ?? null,
	}));
	const [draft, setDraft] = useState(baseline);
	const [saving, setSaving] = useState(false);
	const savingRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const disabled = project.canEditWebglDisplay !== true || isPending || saving;
	const dirty = draft.mode !== baseline.mode || (draft.mode === 'manual' && (draft.width !== baseline.width || draft.height !== baseline.height));
	const prefix = `webgl-display-${project.id}`;
	const edit = (next: typeof draft) => { setDraft(next); setSaved(false); setError(null); };

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (disabled || savingRef.current || !dirty) return;
		const validDigits = /^\d+$/;
		const dimensions = draft.mode === 'manual' ? {
			webglDisplayWidth: validDigits.test(draft.width) ? Number(draft.width) : NaN,
			webglDisplayHeight: validDigits.test(draft.height) ? Number(draft.height) : NaN,
		} : {
			webglDisplayWidth: baseline.width ? Number(baseline.width) : null,
			webglDisplayHeight: baseline.height ? Number(baseline.height) : null,
		};
		const parsed = WebglDisplaySettingsSchema.safeParse({ webglDisplayMode: draft.mode, ...dimensions });
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
			qc.setQueryData(settingsKey, response);
			const next = draftFrom(response);
			setBaseline(next);
			setDraft(draft.mode === 'manual' ? next : { ...next, width: draft.width, height: draft.height });
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
				<p role="status" className="field-hint">{loadingAnalysis ? '빌드 표시 크기를 확인하고 있습니다…' : analysisForbidden ? '분석 결과는 작품 등록자와 관리자만 확인할 수 있습니다.' : analysisError ? '분석 결과를 불러오지 못했습니다. 페이지를 새로고침해 다시 확인하세요.' : !analysis ? '아직 분석하지 않은 빌드입니다. 새 WebGL 빌드를 업로드하면 자동으로 분석합니다.' : analysis.kind === 'fixed' ? `자동 감지: ${analysis.width} × ${analysis.height} CSS px` : analysis.kind === 'responsive' ? '자동 감지: 반응형 빌드 · 사용 가능한 화면 영역에 맞춥니다.' : '표시 크기 지정 권장: 빌드의 표시 크기를 확실하게 감지하지 못했습니다. 자동 모드에서는 기존 방식으로 표시합니다.'}</p>
				<p className="field-hint">게임을 페이지에 표시할 크기(CSS px)입니다. 화면이 작으면 비율을 유지해 맞춥니다. Unity 게임 내부의 렌더링 해상도는 별도로 설정됩니다.</p>
				<div className="form-field">
					<label htmlFor={`${prefix}-mode`}>표시 크기 설정</label>
					<select id={`${prefix}-mode`} value={draft.mode} onChange={(event) => edit({ ...draft, mode: event.target.value as NonNullable<WebglDisplaySettings['webglDisplayMode']> })}>
						<option value="auto">자동 감지 사용 (권장)</option>
						<option value="manual">가로·세로 직접 지정</option>
						<option value="legacy">기존 표시 방식 유지</option>
					</select>
				</div>
				<div className="form-field">
					<label htmlFor={`${prefix}-width`}>가로 (CSS px)</label>
					<input id={`${prefix}-width`} type="text" inputMode="numeric" disabled={draft.mode !== 'manual'} value={draft.width} onChange={(event) => edit({ ...draft, width: event.target.value })} />
				</div>
				<div className="form-field">
					<label htmlFor={`${prefix}-height`}>세로 (CSS px)</label>
					<input id={`${prefix}-height`} type="text" inputMode="numeric" disabled={draft.mode !== 'manual'} value={draft.height} onChange={(event) => edit({ ...draft, height: event.target.value })} />
				</div>
				<p className="field-hint">이 설정은 아래 ‘적용’ 버튼과 별도로 저장됩니다. 모드 변경도 ‘표시 크기 저장’을 눌러야 반영됩니다.</p>
				<button className="btn btn--primary" type="submit" disabled={!dirty || disabled}>{saving ? '표시 크기 저장 중…' : '표시 크기 저장'}</button>
			</fieldset>
			{project.canEditWebglDisplay !== true && <p className="field-hint">WebGL 표시 크기를 변경할 권한이 없습니다.</p>}
			{error && <p className="field-error" role="alert">{error}</p>}
			{saving && <p role="status">표시 크기를 저장하고 있습니다…</p>}
			{saved && <p className="success-message" role="status">표시 크기가 저장되었습니다.</p>}
		</form>
	);
}
