import type { ClientUploadLimits, MaterialUploadLimits } from '../../../lib/upload-limits';

export function ProjectFileLimits({
	limits,
	materialLimits,
}: {
	limits: ClientUploadLimits;
	materialLimits?: MaterialUploadLimits;
}) {
	return (
		<details className="project-file-limits">
			<summary>파일 형식·용량 안내</summary>
			<p className="field-hint">
				이미지 파일당 {limits.imageMaxMb}MB · 동영상 파일당 {limits.videoMaxMb}MB, 최대 5개 · 게임·WebGL ZIP{' '}
				{limits.gameMaxMb}MB
			</p>
			{materialLimits && (
				<p className="field-hint">
					문서·첨부자료는 합쳐 최대 {materialLimits.maxCount}개, 파일당{' '}
					{(materialLimits.maxBytes / 1024 / 1024).toFixed(0)}MB
				</p>
			)}
			<p className="field-hint">
				이미지·동영상·문서·첨부자료를 선택할 수 있습니다. ZIP은 다운로드용 게임, 브라우저 실행용 WebGL,
				첨부자료 중 용도를 선택하세요.
			</p>
		</details>
	);
}
