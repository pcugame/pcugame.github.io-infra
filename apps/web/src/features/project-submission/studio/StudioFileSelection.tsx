import { useId, useState } from 'react';
import { StudioFileHeading } from '../../../components/project/editor/StudioFileHeading';
import { studioFileHint } from '../../../components/project/editor/studioFileHint';
import { ProjectUploadDropZone } from '../../../components/project/editor/ProjectUploadDropZone';
import { classifyProjectFile, type ProjectUploadKind } from '../../../lib/upload/project-files';
import { formatFileSizeMb } from '../../../lib/upload/fileValidation';
import type { ClientUploadLimits, MaterialUploadLimits } from '../../../lib/upload-limits';
import type { SubmissionFilesState } from '../useSubmissionFiles';
import { selectedStudioFiles, studioFileGroups, type StudioFileGroup } from './fileGroups';

export function StudioFileSelection({ files, enabled, limits, materialLimits, retryConfig }: {
	files: SubmissionFilesState;
	enabled: boolean;
	limits: ClientUploadLimits;
	materialLimits?: MaterialUploadLimits;
	retryConfig: () => void;
}) {
	return <div className="studio-files-container"><div className="studio-files-grid">
		{studioFileGroups.map(group => <FileGroup key={group.id} group={group} files={files} enabled={enabled} limits={limits} materialLimits={materialLimits} retryConfig={retryConfig} />)}
	</div></div>;
}
function FileGroup({ group, files, enabled, limits, materialLimits, retryConfig }: Parameters<typeof StudioFileSelection>[0] & { group: StudioFileGroup }) {
	const id = useId();
	const [error, setError] = useState<string | null>(null);
	const build = group.id === 'native' || group.id === 'web';
	const hint = studioFileHint(group.kinds[0], limits, materialLimits);
	const select = (chosen: File[]) => {
		if (!enabled || !chosen.length) return;
		const typed: { kind: Exclude<ProjectUploadKind, 'POSTER'>; file: File }[] = [];
		if (build && chosen.length !== 1) { setError('ZIP 파일 한 개만 선택하세요.'); return; }
		for (const file of chosen) {
			const kind = classifyProjectFile(file, 'files');
			if (build) {
				if (kind !== 'ZIP') { setError('빌드는 ZIP 파일만 선택할 수 있습니다.'); return; }
				typed.push({ kind: group.id === 'native' ? 'GAME' : 'WEBGL', file });
			} else if (group.id === 'video') {
				if (kind !== 'VIDEO') { setError('지원하는 동영상 파일만 선택하세요.'); return; }
				typed.push({ kind, file });
			} else {
				if (kind === 'VIDEO' || file.type.startsWith('video/')) { setError('영상은 동영상 영역에서 선택하세요.'); return; }
				const materialKind = kind === 'IMAGE' || kind === 'DOCUMENT' ? kind : 'ATTACHMENT';
				if (materialKind !== 'IMAGE' && !materialLimits) { setError('자료 업로드 설정을 다시 불러온 뒤 문서·첨부자료를 선택하세요.'); return; }
				typed.push({ kind: materialKind, file });
			}
		}
		files.addFiles(typed, setError);
	};
	const selected = selectedStudioFiles(files).filter(item => (group.kinds as readonly string[]).includes(item.kind));
	return <fieldset className="form-section submission-file-fieldset" data-file-group={group.id} aria-labelledby={`${id}-title`} aria-describedby={[`${id}-hint`, error ? `${id}-error` : ''].filter(Boolean).join(' ')}>
		<StudioFileHeading id={id} label={group.label} hint={hint} error={error} webgl={group.id === 'web'} />
		<ProjectUploadDropZone zone="files" compact label={`${group.label} 파일 선택`} enabled={enabled} hint={hint}
			accept={build ? '.zip,application/zip,application/x-zip-compressed' : group.id === 'video' ? '.mp4,.mov,.m4v,.3gp,.3g2,.mkv,.webm,.avi,.wmv,.asf' : undefined}
			multiple={!build} onFiles={select} footer={<div className="studio-files-scroll" tabIndex={selected.length > 0 ? 0 : undefined} aria-label={`${group.label} 파일 목록`}>
				{group.id === 'materials' && !materialLimits && <p className="field-hint">문서·첨부자료는 설정 조회 후 선택할 수 있습니다. <button type="button" className="btn btn--secondary btn--small" disabled={!enabled} onClick={retryConfig}>설정 다시 불러오기</button></p>}
				{selected.length > 0 && <ul className="project-upload-queue" aria-label={`선택한 ${group.label}`}>
					{selected.map(({ kind, file }, index) => <li key={`${kind}:${index}`}><p title={`${file.name} · ${formatFileSizeMb(file.size)} MB`}><strong>{file.name}</strong> · {formatFileSizeMb(file.size)} MB</p>
						<button type="button" className="btn btn--secondary btn--small" disabled={!enabled} aria-label={`${file.name} 선택 취소`} onClick={() => { files.removeFile(kind, file); setError(null); }}>선택 취소</button></li>)}
				</ul>}
			</div>} />
	</fieldset>;
}
