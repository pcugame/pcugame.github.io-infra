import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorMessage, LoadingSpinner } from '../components/common';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';

export default function ProjectPlayPage() {
	const { projectId: projectIdParam } = useParams<{ projectId: string }>();
	const projectId = Number(projectIdParam);
	const { data: project, isLoading, error, refetch } = useQuery({
		queryKey: queryKeys.projectDetailById(projectId),
		queryFn: () => publicApi.getProjectDetail(projectId),
		enabled: Number.isInteger(projectId) && projectId > 0,
	});

	if (isLoading) return <main className="project-play-page project-play-page--message"><LoadingSpinner /></main>;
	if (error) {
		return (
			<main className="project-play-page project-play-page--message">
				<ErrorMessage error={error} onReset={() => refetch()} />
				<Link className="btn btn--secondary" to={`/projects/${projectId}`}>작품으로 돌아가기</Link>
			</main>
		);
	}
	if (!project) return null;

	return (
		<main className="project-play-page">
			<header className="project-play-page__header">
				<div>
					<span>WebGL Player</span>
					<h1>{project.title}</h1>
				</div>
				<Link className="btn btn--secondary btn--small" to={`/projects/${project.id}`}>
					작품으로 돌아가기
				</Link>
			</header>

			{project.webglUrl ? (
				<div className="project-play-page__frame-wrap">
					<iframe
						{...{ credentialless: '' }}
						className="project-play-page__frame"
						src={project.webglUrl}
						title={`${project.title} WebGL 플레이어`}
						sandbox="allow-scripts allow-pointer-lock allow-same-origin"
						allow="fullscreen; autoplay"
						referrerPolicy="no-referrer"
					/>
				</div>
			) : (
				<section className="project-play-page__empty">
					<h2>플레이할 WebGL 빌드가 없습니다.</h2>
					<p>빌드가 아직 등록되지 않았거나 삭제되었습니다.</p>
				</section>
			)}
		</main>
	);
}
