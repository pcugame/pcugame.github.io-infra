import { Link } from 'react-router-dom';

interface ProjectActionsProps {
	projectId: number;
	gameDownloadUrl?: string;
	webglUrl?: string;
	webglPlayUrl?: string;
	className?: string;
	pending?: { game?: string; webgl?: string };
}

export function ProjectActions({
	projectId,
	gameDownloadUrl,
	webglUrl,
	webglPlayUrl,
	className = '',
	pending,
}: ProjectActionsProps) {
	if (!gameDownloadUrl && !webglUrl && !webglPlayUrl && !pending?.game && !pending?.webgl) return null;
	return (
		<div className={`project-actions ${className}`.trim()}>
			{gameDownloadUrl && (
				<a href={gameDownloadUrl} className="btn btn--primary" download>
					게임 다운로드 (ZIP)
				</a>
			)}
			{(webglPlayUrl || webglUrl) && (
				<Link
					to={webglPlayUrl ?? `/projects/${projectId}/play`}
					className="btn btn--secondary"
					target="_blank"
					rel="noopener noreferrer"
				>
					플레이해보기
				</Link>
			)}
			{pending?.game && <button type="button" className="btn btn--primary" disabled title={`${pending.game} — 업로드 후 다운로드할 수 있습니다.`}>게임 다운로드 (ZIP)</button>}
			{pending?.webgl && <button type="button" className="btn btn--secondary" disabled title={`${pending.webgl} — 업로드 후 실행할 수 있습니다.`}>플레이해보기</button>}
		</div>
	);
}
