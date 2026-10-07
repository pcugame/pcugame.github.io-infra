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
		<div className="form-field" role="group" aria-label="지원 플랫폼">
			<span>지원 플랫폼</span>
			{PROJECT_PLATFORMS.map((platform) => <label key={platform} className="form-field--checkbox">
				<input type="checkbox" checked={platforms.includes(platform)} onChange={(event) => onPlatformsChange(PROJECT_PLATFORMS.filter((value) => value === platform ? event.target.checked : platforms.includes(value)))} />
				{PLATFORM_LABELS[platform]}
			</label>)}
		</div>
		<div className="form-field">
			<label htmlFor={id}>필수 하드웨어</label>
			<textarea id={id} rows={3} maxLength={MAX_HARDWARE_REQUIREMENTS_LENGTH} value={hardwareRequirements} onChange={(event) => onHardwareRequirementsChange(event.target.value)} placeholder="예: VR 헤드셋과 컨트롤러 필요" aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
			{error && <span id={`${id}-error`} className="field-error">{error}</span>}
		</div>
	</fieldset>;
}
