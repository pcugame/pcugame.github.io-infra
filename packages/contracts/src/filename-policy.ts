export const MAX_PORTABLE_FILENAME_BYTES = 255;
export const MAX_NEW_PROJECT_TITLE_BYTES = 125;
export const GAME_DOWNLOAD_FALLBACK_FILENAME = 'game.zip';

export type FilenameValidationReasonCode =
	| 'empty'
	| 'too_long'
	| 'dot_segment'
	| 'path_separator'
	| 'forbidden_character'
	| 'control_character'
	| 'bidi_control'
	| 'invalid_unicode'
	| 'trailing_dot_or_space'
	| 'reserved_basename';

export type FilenameValidationReason = {
	code: FilenameValidationReasonCode;
	message: string;
};

export type GameDownloadMember = {
	id: number;
	name: string;
	studentId: string;
	sortOrder: number;
};

const PATH_SEPARATOR_RE = /[/\\]/u;
const FORBIDDEN_CHARACTER_RE = /[<>:"|?*]/u;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/u;
const TRAILING_DOT_OR_SPACE_RE = /[. ]$/u;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

export function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				i += 1;
				continue;
			}
			return true;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function baseNameBeforeExtension(value: string): string {
	const dot = value.indexOf('.');
	return (dot >= 0 ? value.slice(0, dot) : value).trim();
}

export function validateUploadFilename(filename: string): FilenameValidationReason[] {
	const reasons: FilenameValidationReason[] = [];
	const byteLength = utf8ByteLength(filename);

	if (filename.trim().length === 0) {
		reasons.push({ code: 'empty', message: '파일명이 비어 있습니다.' });
	}
	if (byteLength > MAX_PORTABLE_FILENAME_BYTES) {
		reasons.push({
			code: 'too_long',
			message: `파일명이 UTF-8 기준 ${byteLength}바이트로 ${MAX_PORTABLE_FILENAME_BYTES}바이트 제한을 초과합니다.`,
		});
	}
	if (filename === '.' || filename === '..') {
		reasons.push({ code: 'dot_segment', message: '파일명으로 . 또는 ..을 사용할 수 없습니다.' });
	}
	if (PATH_SEPARATOR_RE.test(filename)) {
		reasons.push({ code: 'path_separator', message: '파일명에 경로 구분자(/ 또는 \\)를 사용할 수 없습니다.' });
	}
	if (FORBIDDEN_CHARACTER_RE.test(filename)) {
		reasons.push({ code: 'forbidden_character', message: '파일명에 금지 문자(< > : " | ? *)를 사용할 수 없습니다.' });
	}
	if (CONTROL_CHARACTER_RE.test(filename)) {
		reasons.push({ code: 'control_character', message: '파일명에 제어 문자를 사용할 수 없습니다.' });
	}
	if (BIDI_CONTROL_RE.test(filename)) {
		reasons.push({ code: 'bidi_control', message: '파일명에 문자 방향 제어 문자를 사용할 수 없습니다.' });
	}
	if (hasUnpairedSurrogate(filename)) {
		reasons.push({ code: 'invalid_unicode', message: '파일명에 올바르지 않은 Unicode 문자가 포함되어 있습니다.' });
	}
	if (TRAILING_DOT_OR_SPACE_RE.test(filename)) {
		reasons.push({ code: 'trailing_dot_or_space', message: '파일명은 점이나 공백으로 끝날 수 없습니다.' });
	}
	if (WINDOWS_RESERVED_BASENAME_RE.test(baseNameBeforeExtension(filename))) {
		reasons.push({ code: 'reserved_basename', message: '운영체제 예약 파일명은 사용할 수 없습니다.' });
	}

	return reasons;
}

function replaceUnpairedSurrogates(value: string): string {
	let result = '';
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				result += value[i] + value[i + 1];
				i += 1;
			} else {
				result += '_';
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			result += '_';
		} else {
			result += value[i];
		}
	}
	return result;
}

export function sanitizeFilenameComponent(value: string, fallback = 'unknown'): string {
	let sanitized = replaceUnpairedSurrogates(value)
		.normalize('NFC')
		.trim()
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/gu, '_')
		.replace(/\s+/gu, ' ')
		.replace(/[. ]+$/u, '');

	if (!sanitized || sanitized === '.' || sanitized === '..') sanitized = fallback;
	if (WINDOWS_RESERVED_BASENAME_RE.test(baseNameBeforeExtension(sanitized))) sanitized = `_${sanitized}`;
	return sanitized;
}

export function buildGameDownloadFilename(
	projectTitle: string,
	members: GameDownloadMember[],
): { filename: string; usedFallback: boolean } {
	const components = [sanitizeFilenameComponent(projectTitle, 'game')];
	const sortedMembers = [...members].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
	for (const member of sortedMembers) {
		components.push(sanitizeFilenameComponent(member.name));
		components.push(sanitizeFilenameComponent(member.studentId));
	}

	const filename = `${components.join('_')}.zip`;
	if (utf8ByteLength(filename) > MAX_PORTABLE_FILENAME_BYTES) {
		// TODO: Preserve as many complete member pairs as possible and append `_외N명`
		// once the product-facing abbreviation policy is finalized.
		return { filename: GAME_DOWNLOAD_FALLBACK_FILENAME, usedFallback: true };
	}
	return { filename, usedFallback: false };
}

function encodeRfc5987Value(value: string): string {
	return encodeURIComponent(value).replace(/['()*]/gu, (char) =>
		`%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

export function attachmentContentDisposition(filename: string): string {
	const safeFilename = sanitizeFilenameComponent(filename, GAME_DOWNLOAD_FALLBACK_FILENAME);
	return `attachment; filename="${GAME_DOWNLOAD_FALLBACK_FILENAME}"; filename*=UTF-8''${encodeRfc5987Value(safeFilename)}`;
}
