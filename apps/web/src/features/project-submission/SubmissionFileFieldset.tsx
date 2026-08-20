import type { ClientUploadLimits } from '../../lib/upload-limits';
import type { SubmissionFilesState } from './useSubmissionFiles';

interface SubmissionFileFieldsetProps {
	files: SubmissionFilesState;
	gameUploadHint: string;
	webglUploadHint: string;
	limits: ClientUploadLimits;
}

export function SubmissionFileFieldset({
	files,
	gameUploadHint,
	webglUploadHint,
	limits,
}: SubmissionFileFieldsetProps) {
	const {
		clearGameFile,
		clearWebglFile,
		clearImages,
		clearPoster,
		fileSizeError,
		gameFile,
		gameInputRef,
		webglInputRef,
		handleGameChange,
		handleWebglChange,
		handleImagesChange,
		handlePosterChange,
		imageFiles,
		imagesInputRef,
		posterFile,
		posterInputRef,
		posterPreview,
		webglFile,
	} = files;

	return (
		<fieldset>
			<legend>파일 업로드</legend>

			{fileSizeError && (
				<div className="error-box" role="alert">
					<p>{fileSizeError}</p>
				</div>
			)}

			<div className="form-field">
				<label htmlFor="poster">포스터 이미지 (JPG · PNG · WebP 최대 {limits.posterMaxMb}MB / PDF 최대 {limits.posterPdfMaxMb}MB, PDF는 첫 페이지를 WEBP로 자동 변환)</label>
				<input
					id="poster"
					type="file"
					accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
					ref={posterInputRef}
					onChange={handlePosterChange}
				/>
				{posterFile && (
					<div className="file-selected-row">
						<p className="file-info">
							{posterFile.name} ({(posterFile.size / 1024 / 1024).toFixed(1)}MB)
						</p>
						<button
							type="button"
							className="btn btn--danger btn--small"
							onClick={clearPoster}
						>
							제거
						</button>
					</div>
				)}
				{posterPreview && (
					<div className="poster-preview">
						<img src={posterPreview} alt="포스터 미리보기" />
					</div>
				)}
			</div>

			<div className="form-field">
				<label>동영상</label>
				<p className="field-hint">
					대용량 동영상은 API 업로드를 지원하지 않습니다. direct staging 워크플로우가 배포된 후 사용할 수 있습니다.
				</p>
			</div>

			<div className="form-field">
				<label htmlFor="images">추가 이미지 (JPG · PNG · WebP 각 최대 {limits.imageMaxMb}MB / PDF 최대 {limits.imagePdfMaxMb}MB, PDF는 첫 페이지를 WEBP로 자동 변환, 복수 선택)</label>
				<input
					id="images"
					type="file"
					accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
					multiple
					ref={imagesInputRef}
					onChange={handleImagesChange}
				/>
				{imageFiles.length > 0 && (
					<div className="file-selected-row">
						<p className="file-info">{imageFiles.length}개 파일 선택됨</p>
						<button
							type="button"
							className="btn btn--danger btn--small"
							onClick={clearImages}
						>
							제거
						</button>
					</div>
				)}
			</div>

			<div className="form-field">
				<label htmlFor="gameFile">게임 파일 (ZIP, 최대 {limits.gameMaxMb}MB)</label>
				<input
					id="gameFile"
					type="file"
					accept=".zip,application/zip,application/x-zip-compressed"
					ref={gameInputRef}
					onChange={handleGameChange}
				/>
				{gameFile && (
					<div className="file-selected-row">
						<p className="file-info">
							{gameFile.name} ({(gameFile.size / 1024 / 1024).toFixed(1)}MB)
						</p>
						<button
							type="button"
							className="btn btn--danger btn--small"
							onClick={clearGameFile}
						>
							제거
						</button>
					</div>
				)}
				<p className="field-hint">
					{gameUploadHint}
				</p>
			</div>

			<div className="form-field">
				<label htmlFor="webglFile">WebGL 빌드 파일 (ZIP, 최대 {limits.gameMaxMb}MB)</label>
				<input
					id="webglFile"
					type="file"
					accept=".zip,application/zip,application/x-zip-compressed"
					ref={webglInputRef}
					onChange={handleWebglChange}
				/>
				{webglFile && (
					<div className="file-selected-row">
						<p className="file-info">
							{webglFile.name} ({(webglFile.size / 1024 / 1024).toFixed(1)}MB)
						</p>
						<button
							type="button"
							className="btn btn--danger btn--small"
							onClick={clearWebglFile}
						>
							제거
						</button>
					</div>
				)}
				<p className="field-hint">{webglUploadHint}</p>
			</div>
		</fieldset>
	);
}
