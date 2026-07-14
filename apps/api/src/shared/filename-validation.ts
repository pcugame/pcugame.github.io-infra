import { validateUploadFilename } from '@pcu/contracts';
import { AppError } from './errors.js';

export function assertValidUploadFilename(filename: string): void {
	const reasons = validateUploadFilename(filename);
	if (reasons.length === 0) return;

	throw new AppError(
		400,
		`업로드 파일명을 사용할 수 없습니다: ${reasons.map((reason) => reason.message).join(' ')}`,
		'INVALID_FILENAME',
		{ reasons },
	);
}
