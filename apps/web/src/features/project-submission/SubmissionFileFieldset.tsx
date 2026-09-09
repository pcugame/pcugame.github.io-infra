import type { ClientUploadLimits, MaterialUploadLimits } from '../../lib/upload-limits';
import type { SubmissionFilesState } from './useSubmissionFiles';

interface SubmissionFileFieldsetProps {
	files: SubmissionFilesState;
	gameUploadHint: string;
	webglUploadHint: string;
	limits: ClientUploadLimits;
	materialLimits?: MaterialUploadLimits;
}

export function SubmissionFileFieldset({
	files,
	gameUploadHint,
	webglUploadHint,
	limits,
	materialLimits,
}: SubmissionFileFieldsetProps) {
	const {
		clearGameFile,
		clearWebglFile,
		clearImages,
		clearPoster,
		clearVideo,
		clearDocuments,
		clearAttachments,
		fileSizeError,
		gameFile,
		gameInputRef,
		webglInputRef,
		handleGameChange,
		handleWebglChange,
		handleImagesChange,
		handlePosterChange,
		handleVideoChange,
		handleDocumentsChange,
		handleAttachmentsChange,
		imageFiles,
		imagesInputRef,
		posterFile,
		posterInputRef,
		posterPreview,
		videoFiles,
		videoInputRef,
		documentsInputRef,
		attachmentsInputRef,
		webglFile,
		documentFiles,
		attachmentFiles,
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
				<label htmlFor="videoFile">동영상 (MP4 · MKV · WebM · AVI · WMV, 자동 MP4 변환, 파일당 최대 {limits.videoMaxMb}MB · 프로젝트당 최대 5개)</label>
				<input
					id="videoFile"
					type="file"
					accept="video/mp4,video/x-matroska,video/webm,video/x-msvideo,video/x-ms-wmv,.mp4,.mkv,.webm,.avi,.wmv"
					multiple
					disabled={videoFiles.length >= 5}
					ref={videoInputRef}
					onChange={handleVideoChange}
				/>
				{videoFiles.length >= 5 && <p className="field-hint">동영상은 프로젝트당 최대 5개까지 등록할 수 있습니다.</p>}
				{videoFiles.length > 0 && (
					<div className="file-selected-row">
						<p className="file-info">
							{videoFiles.length}개 파일 선택됨: {videoFiles.map((file) => file.name).join(', ')}
						</p>
						<button
							type="button"
							className="btn btn--danger btn--small"
							onClick={clearVideo}
						>
							제거
						</button>
					</div>
				)}
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

			{materialLimits && (
				<>
					<div className="form-field">
						<label htmlFor="documents">프로젝트 문서 (텍스트 · Markdown · PDF · 오피스 문서, 파일당 최대 {(materialLimits.maxBytes / 1024 / 1024).toFixed(0)}MB)</label>
						<input id="documents" type="file" accept="text/plain,text/markdown,application/pdf,.txt,.md,.markdown,.pdf,.doc,.docx,.odt,.ods,.odp,.rtf,.xls,.xlsx,.ppt,.pptx" multiple disabled={documentFiles.length + attachmentFiles.length >= materialLimits.maxCount} ref={documentsInputRef} onChange={handleDocumentsChange} />
						{documentFiles.length > 0 && (
							<div className="file-selected-row">
								<p className="file-info">{documentFiles.map((file) => file.name).join(', ')}</p>
								<button type="button" className="btn btn--danger btn--small" onClick={clearDocuments}>제거</button>
							</div>
						)}
					</div>
					<div className="form-field">
						<label htmlFor="attachments">기타 첨부자료 (문서와 합쳐 프로젝트당 최대 {materialLimits.maxCount}개 · 파일당 최대 {(materialLimits.maxBytes / 1024 / 1024).toFixed(0)}MB)</label>
						<input id="attachments" type="file" multiple disabled={documentFiles.length + attachmentFiles.length >= materialLimits.maxCount} ref={attachmentsInputRef} onChange={handleAttachmentsChange} />
						{attachmentFiles.length > 0 && (
							<div className="file-selected-row">
								<p className="file-info">{attachmentFiles.map((file) => file.name).join(', ')}</p>
								<button type="button" className="btn btn--danger btn--small" onClick={clearAttachments}>제거</button>
							</div>
						)}
					</div>
				</>
			)}

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
