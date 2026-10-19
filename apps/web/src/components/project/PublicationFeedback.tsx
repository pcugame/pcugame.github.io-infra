import type { PublicationReadiness } from '@pcu/contracts';
import { FormSection, Button } from '../ui';
import { publicationRequirementLabels } from './publication-labels';
const states = { READY: '준비됨', MISSING: '누락', PROCESSING: '처리 중', FAILED: '실패' };
export function PublicationFeedback({ readiness, onStep }: { readiness?: PublicationReadiness; onStep(step: number): void }) {
 if (!readiness) return null;
 return <FormSection className="publication-feedback" legend="공개 조건">
  <p className="field-hint">포스터·네이티브 게임·동영상 처리가 완료되면 공개할 수 있습니다. WebGL·스크린샷·기타 자료는 선택입니다.</p>
  <ul>{readiness.requirements.map(item => <li key={item.key} data-state={item.state}>
   <Button type="button" variant="secondary" size="small" onClick={() => onStep(['title', 'summary'].includes(item.key) ? 0 : ['members', 'platforms'].includes(item.key) ? 1 : 2)}>{publicationRequirementLabels[item.key]}: {states[item.state]}</Button>
  </li>)}</ul>
 </FormSection>;
}
