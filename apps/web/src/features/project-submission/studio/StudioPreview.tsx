import { submissionAssetChecks } from '../publicAssetRequirements';
import { studioFileGroups, selectedStudioFiles } from './fileGroups';
import { useState } from 'react';
import type { SubmitProjectPayloadInput } from '../../../contracts/schemas';
import { SubmitProjectPayloadSchema } from '../../../contracts/schemas';
import { ProjectCard } from '../../../components/project/ProjectCard';
import { isPdf } from '../../../lib/upload/project-files';
import { ProjectPublicMeta } from '../../../components/project/ProjectPublicMeta';
import { Button } from '../../../components/ui';
import type { SubmissionFilesState } from '../useSubmissionFiles';

export function StudioPreview({ values, files, exhibitionLabel, onPreview }: {
	values: SubmitProjectPayloadInput; files: SubmissionFilesState; exhibitionLabel?: string; onPreview: () => void;
}) {
	const [viewMode, setViewMode] = useState<'poster' | 'grid'>('poster');
	const checks = [
		['전시회 선택', SubmitProjectPayloadSchema.shape.exhibitionId.safeParse(values.exhibitionId).success],
		['작품명 입력', SubmitProjectPayloadSchema.shape.title.safeParse(values.title).success],
		['참여 학생 입력', SubmitProjectPayloadSchema.shape.members.safeParse(values.members).success],
	] as const;
	const publicProject = (values.visibility ?? 'PUBLIC') === 'PUBLIC';
	const assetChecks = submissionAssetChecks(files);
	const count = checks.filter(([, ready]) => ready).length + (publicProject ? assetChecks.filter(check => check.ready).length : 0);
	const total = checks.length + (publicProject ? assetChecks.length : 0);
	const members = values.members.filter(member => member.name.trim() || member.studentId.trim());
	const pdfPoster = files.posterFile && isPdf(files.posterFile);
	return <>
		<div className="submission-studio__preview-heading"><h2>전시 카드 미리보기</h2><span>입력 내용 반영</span></div>
		<div className="submission-studio__preview-modes" role="group" aria-label="카드 표시 방식">
			<Button size="small" variant="secondary" aria-pressed={viewMode === 'poster'} onClick={() => setViewMode('poster')}>포스터형</Button>
			<Button size="small" variant="secondary" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}>카드형</Button>
		</div>
		<article className={`submission-studio__card-preview archive-grid${viewMode === 'poster' ? ' archive-grid--poster' : ''}`} aria-label="전시 카드 미리보기">
			<ProjectCard year={0} project={{ slug: 'preview', title: values.title || '작품명을 입력하세요', summary: values.summary, members }} localPoster={pdfPoster ? null : files.posterFile} onSelect={onPreview} />
		</article>
		{exhibitionLabel && <p className="submission-studio__exhibition">{exhibitionLabel}</p>}
		{pdfPoster && <p className="field-hint">PDF 포스터는 업로드 처리 후 첫 페이지가 카드에 표시됩니다.</p>}
		<Button className="submission-studio__preview-link" variant="secondary" size="small" onClick={onPreview}>전체 미리보기 ↗</Button>
		<div className="submission-studio__checklist" role="region" aria-label="필수 정보 준비" aria-live="polite">
			<div><h3>필수 정보 준비</h3><span>{count} / {total}</span></div>
			<progress aria-label="필수 정보 입력 현황" max={total} value={count} />
			<ul>{checks.map(([label, ready]) => <li key={label}><span>{label}</span><span className={ready ? 'is-ready' : ''}>{ready ? '✓ 완료' : '입력 필요'}</span></li>)}{assetChecks.map(({ label, ready }) => <li key={label}><span>{label}{!publicProject && ' (선택)'}</span><span className={ready ? 'is-ready' : ''}>{ready ? '✓ 선택 완료' : publicProject ? '파일 필요' : '선택 안 함'}</span></li>)}</ul>
		</div>
		<p className="submission-studio__aside-note">{publicProject ? '공개 작품에는 네이티브 빌드·웹 빌드·동영상·사진이 모두 필요합니다. 포스터·문서·기타 첨부자료는 선택 사항입니다.' : '파일은 선택 사항입니다.'}<br />선택한 파일은 최종 제출 후 업로드됩니다.</p>
	</>;
}

export function StudioReview({ values, files, exhibitionLabel, visibilityLabel, onEdit }: {
	values: SubmitProjectPayloadInput; files: SubmissionFilesState; exhibitionLabel?: string; visibilityLabel?: string; onEdit: (step: number) => void;
}) {
	const groups = [
		{ label: '포스터', files: files.posterFile ? [files.posterFile] : [] },
		...studioFileGroups.map(group => ({ label: group.label, files: selectedStudioFiles(files).filter(item => (group.kinds as readonly string[]).includes(item.kind)).map(item => item.file) })),
	];
	return <div className="submission-studio__review">
		<div className="submission-studio__review-heading"><h3>작품 소개</h3><Button size="small" variant="secondary" onClick={() => onEdit(0)}>소개 수정</Button></div>
		<dl>
			<div><dt>전시회</dt><dd>{exhibitionLabel || '선택 필요'}</dd></div>
			<div><dt>작품명</dt><dd>{values.title || '입력 필요'}</dd></div>
			<div><dt>한 줄 소개</dt><dd>{values.summary || '입력하지 않음'}</dd></div>
			{visibilityLabel && <div><dt>공개 범위</dt><dd>{visibilityLabel}</dd></div>}
		</dl>
		{values.description && <details><summary>상세 설명 확인</summary><p>{values.description}</p></details>}
		<ProjectPublicMeta platforms={values.platforms} hardwareRequirements={values.hardwareRequirements} externalLinks={values.externalLinks} />
		<div className="submission-studio__review-heading"><h3>팀과 자료</h3><Button size="small" variant="secondary" onClick={() => onEdit(1)}>팀·자료 수정</Button></div>
		<ul className="submission-studio__review-members">{values.members.map((member, i) => <li key={i}><strong>{member.name || '이름 미입력'}</strong><span>{member.studentId || '학번 미입력'}</span></li>)}</ul>
		{groups.map(group => <section key={group.label} aria-label={`${group.label} 확인`}><h4>{group.label}</h4>
			{group.files.length ? <ul className="submission-studio__review-files">{group.files.map((file, i) => <li key={i}><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></li>)}</ul> : <p className="field-hint">선택한 파일이 없습니다.</p>}
		</section>)}
		<p className="submission-studio__notice">제출하면 선택한 파일의 업로드가 시작됩니다. 모든 파일의 검증이 끝나면 설정된 공개 범위에 따라 작품이 공개됩니다.</p>
	</div>;
}
