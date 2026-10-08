import { ProjectIntroductionFields } from '../../../components/project/editor/ProjectIntroductionFields';
import { Controller, useWatch } from 'react-hook-form';
import { Button, FormSection } from '../../../components/ui';
import ExhibitionSelect from '../../../components/ExhibitionSelect';
import { VisibilityNotice, VisibilitySelect } from '../../../components/VisibilitySelect';
import { env } from '../../../lib/env';
import type { useProjectSubmissionForm } from '../useProjectSubmissionForm';

export function StudioIntroduction({ submission }: { submission: ReturnType<typeof useProjectSubmissionForm> }) {
	const { form, errors, years, exhibitionsQuery, selectedYearItem, isUploadLocked } = submission;
	const { control, register } = form;
	const summary = useWatch({ control, name: 'summary' }) ?? '';
	const visibility = useWatch({ control, name: 'visibility' });
	return <>
		<FormSection legend="기본 정보">
			<div className="form-field">
				<label htmlFor="studio-exhibition">전시회 <span className="required-mark">*</span></label>
				<Controller control={control} name="exhibitionId" render={({ field }) => <ExhibitionSelect
					id="studio-exhibition" value={field.value || null} onChange={field.onChange} items={years}
					disabled={exhibitionsQuery.isPending || exhibitionsQuery.isError} aria-invalid={!!errors.exhibitionId}
				/>} />
				{exhibitionsQuery.isPending && <p className="field-hint" role="status">전시회를 불러오고 있습니다.</p>}
				{exhibitionsQuery.isError && <p className="field-error" role="alert">전시회를 불러오지 못했습니다. <Button variant="secondary" size="small" onClick={() => void exhibitionsQuery.refetch()}>다시 불러오기</Button></p>}
				{exhibitionsQuery.isSuccess && years.length === 0 && <p className="field-error">등록된 전시회가 없습니다. 운영자에게 문의하세요.</p>}
				{errors.exhibitionId && <p className="field-error" role="alert">{errors.exhibitionId.message}</p>}
				{isUploadLocked && <p className="field-error" role="alert">이 전시회는 업로드가 잠겨 있습니다. 다른 전시회를 선택하거나 운영자에게 문의하세요.</p>}
			</div>
			<ProjectIntroductionFields title={register('title')} summary={register('summary')} description={register('description')} summaryLength={summary.length} errors={{ title: errors.title?.message, summary: errors.summary?.message, description: errors.description?.message }} />
			{env.VISIBILITY_CONTROLS_ENABLED && <div className="form-field">
				<label htmlFor="studio-visibility">공개 범위</label>
				<VisibilitySelect id="studio-visibility" {...register('visibility')} />
				<VisibilityNotice visibility={visibility} exhibitionVisibility={selectedYearItem?.visibility} />
				<p className="field-hint">작성자·참여자는 공개 범위와 관계없이 조회할 수 있습니다.</p>
			</div>}
		</FormSection>
	</>;
}
