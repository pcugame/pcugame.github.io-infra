import { useState } from 'react';
import type { AdminProjectDetail } from '@pcu/contracts';
import { Link } from 'react-router-dom';

import GameUploadWidget from '../../../components/GameUploadWidget';
import { getApiErrorMessage } from '../../../lib/api';
import type { ClientUploadLimits } from '../../../lib/upload-limits';
import {
	findOversizedAssetFile,
	formatFileSizeMb,
	getAssetLimitMb,
	type UploadAssetKind,
} from '../../../lib/upload/fileValidation';

interface AdminProjectAssetManagerProps {
	project: AdminProjectDetail;
	projectId: number;
	limits: ClientUploadLimits;
	canEditContent: boolean;
	addAssetError: unknown;
	isAddingAsset: boolean;
	isSettingPoster: boolean;
	isRemovingAsset: boolean;
	isRemovingWebgl: boolean;
	onAddAsset: (kind: UploadAssetKind, file: File) => Promise<void>;
	onSetPoster: (assetId: number) => void;
	onRemoveAsset: (assetId: number) => void;
	onRemoveWebgl: () => void;
}

const assetUploadFields = [
	{
		kind: 'POSTER',
		accept: 'image/jpeg,image/png,image/webp,application/pdf,.pdf',
		multiple: false,
		getLabel: (limits: ClientUploadLimits) =>
			`포스터 교체 (JPG · PNG · WebP 최대 ${limits.posterMaxMb}MB / PDF 최대 ${limits.posterPdfMaxMb}MB, PDF는 첫 페이지를 WEBP로 자동 변환)`,
	},
	{
		kind: 'VIDEO',
		accept: 'video/mp4,video/x-matroska,video/webm,video/x-msvideo,video/x-ms-wmv,.mp4,.mkv,.webm,.avi,.wmv',
		multiple: true,
		getLabel: (limits: ClientUploadLimits) =>
			`동영상 업로드 (MP4 · MKV · WebM · AVI · WMV, 자동 MP4 변환, 최대 ${limits.videoMaxMb}MB)`,
	},
	{
		kind: 'IMAGE',
		accept: 'image/jpeg,image/png,image/webp,application/pdf,.pdf',
		multiple: false,
		getLabel: (limits: ClientUploadLimits) =>
			`이미지 추가 (JPG · PNG · WebP 최대 ${limits.imageMaxMb}MB / PDF 최대 ${limits.imagePdfMaxMb}MB, PDF는 첫 페이지를 WEBP로 자동 변환)`,
	},
] as const satisfies {
	kind: UploadAssetKind;
	accept: string;
	multiple: boolean;
	getLabel: (limits: ClientUploadLimits) => string;
}[];

export function AdminProjectAssetManager({
	project,
	projectId,
	limits,
	canEditContent,
	addAssetError,
	isAddingAsset,
	isSettingPoster,
	isRemovingAsset,
	isRemovingWebgl,
	onAddAsset,
	onSetPoster,
	onRemoveAsset,
	onRemoveWebgl,
}: AdminProjectAssetManagerProps) {
	const [assetFileError, setAssetFileError] = useState<string | null>(null);

	const handleAddAssetFiles = async (kind: UploadAssetKind, files: File[]) => {
		const oversized = findOversizedAssetFile(kind, files, limits);
		if (oversized) {
			const maxMb = getAssetLimitMb(kind, oversized, limits);
			setAssetFileError(
				`${oversized.name}: ${formatFileSizeMb(oversized.size)}MB — 최대 ${maxMb}MB까지 허용됩니다.`,
			);
			return;
		}
		setAssetFileError(null);
		for (const file of files) {
			await onAddAsset(kind, file);
		}
	};

	return (
		<fieldset>
			<legend>등록된 자산</legend>

			{project.posterAssetId && (
				<p className="asset-current-poster">
					현재 포스터:{' '}
					<strong>
						{project.assets.find((a) => a.id === project.posterAssetId)
							?.originalName ?? project.posterAssetId}
					</strong>
				</p>
			)}

			{project.assets.length === 0 ? (
				<p>등록된 자산이 없습니다.</p>
			) : (
				<ul className="asset-list">
					{project.assets.map((asset) => {
						const isCurrentPoster = asset.id === project.posterAssetId;
						const canSetAsPoster =
							canEditContent &&
							(asset.kind === 'IMAGE' || asset.kind === 'POSTER') &&
							!isCurrentPoster;
						return (
							<li key={asset.id} className="asset-list__item">
								<span>
									[{asset.kind}] {asset.originalName} (
									{(asset.size / 1024).toFixed(0)}KB)
									{isCurrentPoster && (
										<strong className="asset-poster-label">
											[포스터]
										</strong>
									)}
								</span>
								{asset.kind === 'VIDEO' && asset.playbackStatus && (
									<p className="field-hint">
										재생용: {asset.playbackStatus}
										{asset.playbackError ? ` (${asset.playbackError})` : ''}
									</p>
								)}
								{asset.kind === 'IMAGE' || asset.kind === 'POSTER' ? (
									<img
										src={asset.url}
										alt={asset.originalName}
										className="asset-thumb"
										loading="lazy"
									/>
								) : null}
								{canEditContent && (
									<div className="asset-actions">
										{canSetAsPoster && (
											<button
												className="btn btn--secondary btn--small"
												onClick={() => onSetPoster(asset.id)}
												disabled={isSettingPoster}
											>
												포스터로 지정
											</button>
										)}
										{asset.kind === 'VIDEO' && asset.originalDownloadUrl && (
											<a
												className="btn btn--secondary btn--small"
												href={asset.originalDownloadUrl}
												download
											>
												원본 다운로드
											</a>
										)}
										<button
											className="btn btn--danger btn--small"
											onClick={() => onRemoveAsset(asset.id)}
											disabled={isRemovingAsset}
										>
											삭제
										</button>
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{canEditContent && (
				<>
					<div className="asset-upload-section">
						<h4>자산 추가</h4>
						{assetUploadFields.map(({ getLabel, kind, accept, multiple }) => (
							<div key={kind} className="form-field">
								<label>{getLabel(limits)}</label>
								<input
									type="file"
									accept={accept}
									multiple={multiple}
									disabled={isAddingAsset}
									onChange={(e) => {
										const files = Array.from(e.target.files ?? []);
										e.target.value = '';
										if (files.length > 0) {
											void handleAddAssetFiles(
												kind,
												kind === 'VIDEO' ? files : files.slice(0, 1),
											).catch(() => {});
										}
									}}
								/>
							</div>
						))}
						{addAssetError != null && (
							<p className="field-error">{getApiErrorMessage(addAssetError)}</p>
						)}
						{assetFileError && (
							<p className="field-error">{assetFileError}</p>
						)}
					</div>

					<GameUploadWidget projectId={projectId} uploadKind="GAME" />
					<div className="webgl-asset-manager">
						{project.webglUrl && (
							<div className="webgl-asset-manager__current">
								<p>현재 공개 WebGL 빌드가 배포되어 있습니다.</p>
								<Link
									className="btn btn--secondary btn--small"
									to={`/projects/${projectId}/play`}
									target="_blank"
									rel="noopener noreferrer"
								>
									플레이 페이지 열기
								</Link>
								<button
									type="button"
									className="btn btn--danger btn--small"
									disabled={isRemovingWebgl}
									onClick={onRemoveWebgl}
								>
									{isRemovingWebgl ? '삭제 중…' : 'WebGL 빌드 삭제'}
								</button>
							</div>
						)}
						<GameUploadWidget projectId={projectId} uploadKind="WEBGL" />
					</div>
				</>
			)}
		</fieldset>
	);
}
