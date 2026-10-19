import { useMe } from '../../auth';
import { SelectControl } from '../../../components/ui/SelectControl';
import { ProjectIntroductionFields } from '../../../components/project/editor/ProjectIntroductionFields';
import { Controller, useWatch } from 'react-hook-form';
import { Button, FormSection } from '../../../components/ui';
import ExhibitionSelect from '../../../components/ExhibitionSelect';
import type { useProjectSubmissionForm } from '../useProjectSubmissionForm';

export function StudioIntroduction({ submission }: { submission: ReturnType<typeof useProjectSubmissionForm> }) {
	const { user } = useMe();
	const { form, errors, years, exhibitionsQuery, isUploadLocked } = submission;
	const { control, register } = form;
	const summary = useWatch({ control, name: 'summary' }) ?? '';
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
			{<div className="form-field">
				<label htmlFor="studio-visibility">공개 범위</label>
				<SelectControl id="studio-visibility" {...register('visibility')}><option value="STAFF">비공개</option><option value="PUBLIC">공개</option></SelectControl>
				<p className="field-hint">작성자·참여자는 공개 범위와 관계없이 조회할 수 있습니다.</p>
			</div>}
   {user?.role === 'ADMIN' && <div className="form-field"><label htmlFor="new-publication-exception">예외 공개 사유</label><textarea id="new-publication-exception" maxLength={2000} value={submission.exceptionReason} onChange={event => submission.setExceptionReason(event.target.value)} /><p className="field-hint">필수 자료 면제 사유를 기록합니다. 파일 검증은 면제되지 않습니다.</p></div>}
   <label><input type="checkbox" {...register('allowDuplicateTitle')} /> 별도 작품으로 새 등록</label>
  </FormSection>
	</>;
}
