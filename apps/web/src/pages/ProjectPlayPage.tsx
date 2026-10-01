import { WebglViewport } from '../components/project/WebglViewport';
import { useViewerKey } from '../lib/query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorMessage, LoadingSpinner } from '../components/common';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';

export default function ProjectPlayPage() {
	const [restartCount, setRestartCount] = useState(0);
 const viewerKey = useViewerKey();
	const { projectId: projectIdParam } = useParams<{ projectId: string }>();
	const projectId = Number(projectIdParam);
	const { data: project, isLoading, error, refetch } = useQuery({
		queryKey: viewerKey(queryKeys.projectDetailById(projectId)),
		queryFn: () => publicApi.getProjectDetail(projectId),
		enabled: Number.isInteger(projectId) && projectId > 0,
	});

	useEffect(() => {
		if (project?.webglPlayUrl) window.location.replace(project.webglPlayUrl);
	}, [project?.webglPlayUrl]);
	if (project?.webglPlayUrl) return <main className="project-play-page project-play-page--message"><a href={project.webglPlayUrl} rel="noopener">전용 실행 화면으로 이동</a></main>;

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
		<main className={`project-play-page${project.webglUrl && project.webglDisplayWidth && project.webglDisplayHeight ? ' project-play-page--sized' : ''}`}>
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
				<>
				<section className="project-play-page__help" aria-label="게임 실행 안내">
					<div className="project-play-page__actions">
						<button type="button" className="btn btn--secondary btn--small" onClick={() => {
							if (window.confirm('게임을 다시 시작할까요? 저장하지 않은 진행 상황은 사라질 수 있습니다.')) setRestartCount((count) => count + 1);
						}}>게임 다시 시작</button>
						{project.gameDownloadUrl && <a className="btn btn--secondary btn--small" href={project.gameDownloadUrl} download>게임 다운로드 (ZIP)</a>}
					</div>
					<p>처음 실행할 때는 게임 파일 다운로드에 시간이 걸릴 수 있습니다.</p>
					<details>
						<summary>게임이 실행되지 않나요?</summary>
						<p>브라우저를 최신 버전으로 업데이트하고 그래픽 가속 설정을 확인해 주세요. 실행 여부는 브라우저뿐 아니라 기기의 그래픽 지원과 게임 빌드에 따라 달라집니다.</p>
						<p>문제가 계속되면 작품명, 브라우저 이름과 버전, 화면에 표시된 오류를 운영자에게 알려 주세요.</p>
					</details>
				</section>
				<WebglViewport width={project.webglDisplayWidth} height={project.webglDisplayHeight}>
					<iframe
						key={`${project.id}:${project.webglUrl}:${restartCount}`}
						{...{ credentialless: '' }}
						className="project-play-page__frame"
						src={project.webglUrl}
						title={`${project.title} WebGL 플레이어`}
						sandbox="allow-scripts allow-pointer-lock allow-same-origin"
						allow="fullscreen; autoplay"
						referrerPolicy="no-referrer"
					/>
				</WebglViewport>
				</>
			) : (
				<section className="project-play-page__empty">
					<h2>플레이할 WebGL 빌드가 없습니다.</h2>
					<p>빌드가 아직 등록되지 않았거나 삭제되었습니다.</p>
				</section>
			)}
		</main>
	);
}
