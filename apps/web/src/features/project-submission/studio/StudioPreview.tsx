import { submissionAssetChecks } from '../publicAssetRequirements';
import { useState } from 'react';
import type { SubmitProjectPayloadInput } from '../../../contracts/schemas';
import { SubmitProjectPayloadSchema } from '../../../contracts/schemas';
import { ProjectCard } from '../../../components/project/ProjectCard';
import { isPdf } from '../../../lib/upload/project-files';
import { Button } from '../../../components/ui';
import type { SubmissionFilesState } from '../useSubmissionFiles';

export function StudioPreview({ values, files, exhibitionLabel, onPreview, showCard = true }: {
	values: SubmitProjectPayloadInput; files: SubmissionFilesState; exhibitionLabel?: string; onPreview: () => void; showCard?: boolean;
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
		{showCard && <>
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
		</>}
		<div className="submission-studio__checklist" role="region" aria-label="필수 정보 준비" aria-live="polite">
			<div><h3>필수 정보 준비</h3><span>{count} / {total}</span></div>
			<progress aria-label="필수 정보 입력 현황" max={total} value={count} />
			<ul>{checks.map(([label, ready]) => <li key={label}><span>{label}</span><span className={ready ? 'is-ready' : ''}>{ready ? '✓ 완료' : '입력 필요'}</span></li>)}{assetChecks.map(({ label, ready }) => <li key={label}><span>{label}{!publicProject && ' (선택)'}</span><span className={ready ? 'is-ready' : ''}>{ready ? '✓ 선택 완료' : publicProject ? '파일 필요' : '선택 안 함'}</span></li>)}</ul>
		</div>
		<p className="submission-studio__aside-note">{publicProject ? '공개 작품에는 네이티브 빌드·웹 빌드·동영상·사진이 모두 필요합니다. 포스터·문서·기타 첨부자료는 선택 사항입니다.' : '파일은 선택 사항입니다.'}<br />선택한 파일은 최종 제출 후 업로드됩니다.</p>
	</>;
}
