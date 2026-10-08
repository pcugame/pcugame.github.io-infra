import type { ClientUploadLimits, MaterialUploadLimits } from '../../../lib/upload-limits';
import { formatFileSizeMb } from '../../../lib/upload/fileValidation';

export function studioFileHint(kind: 'POSTER' | 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE', limits: ClientUploadLimits, materialLimits?: MaterialUploadLimits) {
	if (kind === 'POSTER') return `JPG · PNG · WebP 최대 ${limits.posterMaxMb}MB / PDF 최대 ${limits.posterPdfMaxMb}MB`;
	if (kind === 'GAME' || kind === 'WEBGL') return `${kind === 'WEBGL' ? 'Unity WebGL' : '다운로드용'} ZIP 1개 · 최대 ${limits.gameMaxMb}MB`;
	if (kind === 'VIDEO') return `영상 최대 5개 · 파일당 ${limits.videoMaxMb}MB`;
	return `JPG·PNG·WebP ${limits.imageMaxMb}MB / PDF·ZIP 등${materialLimits ? ` ${formatFileSizeMb(materialLimits.maxBytes)}MB · ${materialLimits.maxCount}개` : ''}`;
}
