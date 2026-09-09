import type { AdminProjectDetail, SetProjectVideoOrderRequest } from '@pcu/contracts';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import GameUploadWidget from '../../../components/GameUploadWidget';
import DirectVideoUploadWidget from '../../../components/DirectVideoUploadWidget';
import DirectImageUploadWidget from '../../../components/DirectImageUploadWidget';
import { ResponsiveImage } from '../../../components/common';
import { getApiErrorMessage } from '../../../lib/api';
import { getAdminVideoLabel } from '../../../lib/video-label';
import { publicApi } from '../../../lib/api';
import { materialUploadLimitsFromConfig } from '../../../lib/upload-limits';

type VideoAsset = Extract<AdminProjectDetail['assets'][number], { url: string }> & {
	kind: 'VIDEO';
	videoSortOrder?: number | null;
};

interface AdminProjectAssetManagerProps {
	project: AdminProjectDetail;
	projectId: number;
	canEditContent: boolean;
	isSettingPoster: boolean;
	isRemovingAsset: boolean;
	isRemovingWebgl: boolean;
	isReorderingVideos?: boolean;
	videoOrderError?: unknown;
	onSetPoster: (assetId: number) => void;
	onRemoveAsset: (assetId: number) => void;
	onRemoveWebgl: () => void;
	onReorderVideos?: (body: SetProjectVideoOrderRequest) => void;
}

export function AdminProjectAssetManager({
	project,
	projectId,
	canEditContent,
	isSettingPoster,
	isRemovingAsset,
	isRemovingWebgl,
	isReorderingVideos = false,
	videoOrderError,
	onSetPoster,
	onRemoveAsset,
	onRemoveWebgl,
	onReorderVideos,
}: AdminProjectAssetManagerProps) {
	const { data: uploadConfig } = useQuery({
		queryKey: ['public-upload-config'],
		queryFn: publicApi.getUploadConfig,
	});
	const materialLimits = materialUploadLimitsFromConfig(uploadConfig);
	const materialAssetIds = new Set([
		...(project.attachments ?? []).map((attachment) => attachment.assetId),
		...project.assets.filter((asset) => asset.kind === 'DOCUMENT' || asset.kind === 'ATTACHMENT').map((asset) => asset.id),
	]);
	const availableMaterialSlots = materialLimits ? Math.max(0, materialLimits.maxCount - materialAssetIds.size) : 0;
	const canonicalVideoIndex = new Map(project.videos.map((video, index) => [video.assetId, index]));
	const videoAssets = project.assets
		.filter((asset): asset is VideoAsset => asset.kind === 'VIDEO')
		.sort((left, right) => (canonicalVideoIndex.get(left.id) ?? Infinity) - (canonicalVideoIndex.get(right.id) ?? Infinity));
	// Keep other assets in place while presenting videos in the server's canonical order.
	let nextVideoIndex = 0;
	const orderedAssets = project.assets.map((asset) => asset.kind === 'VIDEO' ? videoAssets[nextVideoIndex++]! : asset);
	const videoAssetIds = videoAssets.map((asset) => asset.id);
	const moveVideo = (assetId: number, targetIndex: number) => {
		const currentIndex = videoAssetIds.indexOf(assetId);
		if (currentIndex < 0 || targetIndex < 0 || targetIndex >= videoAssetIds.length) return;
		const order = [...videoAssetIds];
		order.splice(currentIndex, 1);
		order.splice(targetIndex, 0, assetId);
		onReorderVideos?.({ expectedOrder: videoAssetIds, order });
	};
	return (
		<fieldset>
			<legend>등록된 자산</legend>
			{!!videoOrderError && <p className="field-error" role="alert">{getApiErrorMessage(videoOrderError)} 최신 목록을 확인한 후 다시 시도해 주세요.</p>}

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
					{orderedAssets.map((asset) => {
						const isCurrentPoster = asset.id === project.posterAssetId;
						const videoIndex = videoAssetIds.indexOf(asset.id);
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
								{asset.kind === 'VIDEO' && (
									<p className="field-hint">영상 역할: <strong className="asset-video-role-badge">{getAdminVideoLabel(asset.videoSortOrder)}</strong></p>
								)}
								{asset.kind === 'THUMBNAIL' || asset.kind === 'IMAGE' || asset.kind === 'POSTER' ? (
									<ResponsiveImage
										image={asset.image}
										alt={asset.originalName}
										className="asset-thumb"
										sizes="160px"
										loading="lazy"
										decoding="async"
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
										{(asset.kind === 'DOCUMENT' || asset.kind === 'ATTACHMENT') && (
											<a className="btn btn--secondary btn--small" href={asset.downloadUrl} download>
												다운로드
											</a>
										)}
										{asset.kind === 'VIDEO' && (
											<>
												<button
													className="btn btn--secondary btn--small"
													onClick={() => moveVideo(asset.id, 0)}
													disabled={isReorderingVideos || videoAssets.length > 5 || (videoIndex === 0 && asset.videoSortOrder === 0)}
												>
													메인으로 지정
												</button>
												<button
													className="btn btn--secondary btn--small"
													onClick={() => moveVideo(asset.id, videoIndex - 1)}
													disabled={isReorderingVideos || videoAssets.length > 5 || videoIndex <= 0}
												>
													위로
												</button>
												<button
													className="btn btn--secondary btn--small"
													onClick={() => moveVideo(asset.id, videoIndex + 1)}
													disabled={isReorderingVideos || videoAssets.length > 5 || videoIndex < 0 || videoIndex >= videoAssetIds.length - 1}
												>
													아래로
												</button>
											</>
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
						<p className="field-hint">이미지와 포스터는 브라우저에서 Garage로 직접 전송됩니다.</p>
						<DirectImageUploadWidget owner={{ type: 'PROJECT', id: projectId }} kind="POSTER" />
						<DirectImageUploadWidget owner={{ type: 'PROJECT', id: projectId }} kind="IMAGE" />
						{videoAssets.length >= 5 ? (
							<p className="field-hint">동영상은 프로젝트당 최대 5개까지 등록할 수 있습니다.</p>
						) : (
							<DirectVideoUploadWidget projectId={projectId} maxFiles={5 - videoAssets.length} />
						)}
						{materialLimits && availableMaterialSlots > 0 && (
							<>
								<DirectVideoUploadWidget
									projectId={projectId}
									maxFiles={availableMaterialSlots}
									maxFileBytes={materialLimits.maxBytes}
									kind="DOCUMENT"
									label="문서"
									accept="text/plain,text/markdown,application/pdf,.txt,.md,.markdown,.pdf,.doc,.docx,.odt,.ods,.odp,.rtf,.xls,.xlsx,.ppt,.pptx"
								/>
								<DirectVideoUploadWidget
									projectId={projectId}
									maxFiles={availableMaterialSlots}
									maxFileBytes={materialLimits.maxBytes}
									kind="ATTACHMENT"
									label="첨부자료"
								/>
							</>
						)}
						{materialLimits && availableMaterialSlots === 0 && <p className="field-hint">문서와 첨부자료는 프로젝트당 최대 {materialLimits.maxCount}개까지 등록할 수 있습니다.</p>}
					</div>

					<GameUploadWidget projectId={projectId} uploadKind="GAME" />
					<div className="webgl-asset-manager">
						{project.webglUrl && (
							<div className="webgl-asset-manager__current">
								<p>현재 공개 WebGL 빌드가 배포되어 있습니다.</p>
								{project.webglDeployment ? (
									<p className="field-hint">
										불변 배포 ID: <code>{project.webglDeployment.id}</code>
									</p>
								) : (
									<p className="field-hint">기존 WebGL 배포를 canonical 구조로 승격 중입니다.</p>
								)}
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
