import { useState } from 'react';
import type { AwardState } from '@pcu/contracts';
import { Button, TextField } from '../../../components/ui';
import { AwardIcon } from '../../../components/project/AwardIcon';
import { awardStyle, awardTone } from '../../../components/project/awardTone';
import { laurelIcons } from '../../../components/project/awardIcons';
import { awardApi } from '../../../lib/api/awards';

type Props = {
  exhibitionId: number;
  state: AwardState;
  award: AwardState['items'][number];
  busy: boolean;
  save: (action: () => Promise<AwardState>) => Promise<AwardState | undefined>;
};

export function AwardColorEditor({ exhibitionId, state, award, busy, save }: Props) {
  const fallback = laurelIcons.find(icon => icon.key === award.builtinKey)?.color ?? '#D4A437';
  const [value, setValue] = useState(award.color ?? fallback);
  const [dirty, setDirty] = useState(false);
  const normalized = value.trim().toUpperCase();
  const valid = /^#[0-9A-F]{6}$/.test(normalized);
  const preview = { ...award, color: dirty && valid ? normalized : award.color };
  const changed = dirty && valid && normalized !== award.color?.toUpperCase();
  const update = (color: string) => { setValue(color); setDirty(true); };
  const saveColor = async (color: string | null) => {
    if (busy) return;
    const result = await save(() => awardApi.edit(exhibitionId, state.version, {
      id: award.id, name: award.name, builtinKey: award.builtinKey, assetId: award.assetId, color,
    }));
    if (result) setDirty(false);
  };
  return <div className="award-color-editor">
    <div className="award-color-editor__controls">
      <label className="form-field award-color-editor__picker">
        <span className="form-field__label">상 색상</span>
        <input type="color" aria-label={`${award.name} 색상 선택`} value={valid ? normalized : award.color ?? fallback}
          disabled={busy} onChange={event => update(event.target.value)} />
      </label>
      <TextField label="색상 코드" value={value} placeholder="#7C3AED" maxLength={7} disabled={busy}
        spellCheck={false} autoComplete="off" error={dirty && !valid ? '# 뒤에 6자리 색상 코드를 입력하세요.' : undefined}
        onChange={event => update(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && changed) { event.preventDefault(); void saveColor(normalized); } }} />
      <span className="project-award award-color-editor__preview" data-award-tone={awardTone(preview)} style={awardStyle(preview)} aria-label="색상 미리보기">
        <AwardIcon award={preview} className="project-award__icon" /><span>{award.name}</span>
      </span>
      <Button size="small" disabled={busy || !changed} onClick={() => void saveColor(normalized)}>색상 저장</Button>
      <Button size="small" variant="secondary" disabled={busy || !award.color} onClick={() => void saveColor(null)}>기본 색상 복원</Button>
    </div>
    <p className="field-hint">월계관, 수상 테두리와 빛 효과에 적용됩니다. 커스텀 이미지 자체의 색은 유지됩니다.</p>
  </div>;
}
