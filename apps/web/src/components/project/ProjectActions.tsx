import { Link } from 'react-router-dom';

interface ProjectActionsProps {
	projectId: number;
	gameDownloadUrl?: string;
	webglUrl?: string;
	className?: string;
}

export function ProjectActions({
	projectId,
	gameDownloadUrl,
	webglUrl,
	className = '',
}: ProjectActionsProps) {
	if (!gameDownloadUrl && !webglUrl) return null;
	return (
		<div className={`project-actions ${className}`.trim()}>
			{gameDownloadUrl && (
				<a href={gameDownloadUrl} className="btn btn--primary" download>
					게임 다운로드 (ZIP)
				</a>
			)}
			{webglUrl && (
				<Link
					to={`/projects/${projectId}/play`}
					className="btn btn--secondary"
					target="_blank"
					rel="noopener noreferrer"
				>
					플레이해보기
				</Link>
			)}
		</div>
	);
}
