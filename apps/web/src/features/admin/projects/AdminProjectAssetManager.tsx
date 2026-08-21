import type { AdminProjectDetail } from '@pcu/contracts';
import { Link } from 'react-router-dom';

import GameUploadWidget from '../../../components/GameUploadWidget';
import DirectVideoUploadWidget from '../../../components/DirectVideoUploadWidget';
import DirectImageUploadWidget from '../../../components/DirectImageUploadWidget';
import { ResponsiveImage } from '../../../components/common';
import type { ClientUploadLimits } from '../../../lib/upload-limits';

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
	/** Legacy inline upload bridge; new controls below never invoke it. */
	onAddAsset: (kind: 'IMAGE' | 'POSTER', file: File) => Promise<void>;
	onSetPoster: (assetId: number) => void;
	onRemoveAsset: (assetId: number) => void;
	onRemoveWebgl: () => void;
}

export function AdminProjectAssetManager({
	project,
	projectId,
	canEditContent,
	addAssetError,
	isSettingPoster,
	isRemovingAsset,
	isRemovingWebgl,
	onSetPoster,
	onRemoveAsset,
	onRemoveWebgl,
}: AdminProjectAssetManagerProps) {
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
						<DirectVideoUploadWidget projectId={projectId} />
						{addAssetError != null && <p className="field-hint">기존 inline 업로드 오류는 legacy client에만 적용됩니다.</p>}
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
