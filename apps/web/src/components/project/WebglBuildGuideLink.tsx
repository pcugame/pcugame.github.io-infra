import { env } from '../../lib/env';

export function WebglBuildGuideLink() {
	return (
		<span className="webgl-guide-link"><a className="submission-upload-help" href={`${env.BASE_PATH}unity-webgl-guide/index.html`} target="_blank" rel="noopener noreferrer">
			WebGL 빌드 방법
			<span className="sr-only"> (새 탭)</span>
		</a><span className="webgl-guide-link-mark" aria-hidden="true">*</span></span>
	);
}
