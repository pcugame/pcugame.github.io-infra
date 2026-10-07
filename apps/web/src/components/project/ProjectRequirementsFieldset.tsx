import { useId } from 'react';
import { MAX_HARDWARE_REQUIREMENTS_LENGTH, PROJECT_PLATFORMS, type Platform } from '@pcu/contracts';
import { PLATFORM_LABELS } from './platforms';

interface Props {
	platforms: Platform[];
	hardwareRequirements: string;
	onPlatformsChange: (value: Platform[]) => void;
	onHardwareRequirementsChange: (value: string) => void;
	disabled?: boolean;
	error?: string;
}

export function ProjectRequirementsFieldset({ platforms, hardwareRequirements, onPlatformsChange, onHardwareRequirementsChange, disabled, error }: Props) {
	const id = useId();
	return <fieldset disabled={disabled}>
		<legend>실행 환경</legend>
		<div className="form-field" role="group" aria-labelledby={`${id}-platforms`}>
			<span id={`${id}-platforms`} className="form-field__label">지원 플랫폼</span>
			<div className="form-checkbox-group form-field--checkbox">
			{PROJECT_PLATFORMS.map((platform) => <label key={platform}>
				<input type="checkbox" checked={platforms.includes(platform)} onChange={(event) => onPlatformsChange(PROJECT_PLATFORMS.filter((value) => value === platform ? event.target.checked : platforms.includes(value)))} />
				{PLATFORM_LABELS[platform]}
			</label>)}
			</div>
		</div>
		<div className="form-field">
			<label htmlFor={id}>필수 하드웨어</label>
			<textarea id={id} rows={3} maxLength={MAX_HARDWARE_REQUIREMENTS_LENGTH} value={hardwareRequirements} onChange={(event) => onHardwareRequirementsChange(event.target.value)} placeholder="예: VR 헤드셋과 컨트롤러 필요" aria-invalid={!!error} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} />
			<p id={`${id}-hint`} className="field-hint">VR 헤드셋, 전용 컨트롤러 등 실행에 필요한 장비가 있을 때 입력하세요.</p>
			{error && <span id={`${id}-error`} className="field-error">{error}</span>}
		</div>
	</fieldset>;
}
