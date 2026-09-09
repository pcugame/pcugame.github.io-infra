import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectStatus } from '../contracts';
import { adminProjectApi, changeRequestApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../components/common';

const STATUS_LABELS: Record<ProjectStatus, string> = {
	DRAFT: '초안',
	PUBLISHED: '공개',
	ARCHIVED: '보관',
};

const STATUS_COLORS: Record<ProjectStatus, string> = {
	DRAFT: 'badge--draft',
	PUBLISHED: 'badge--published',
	ARCHIVED: 'badge--archived',
};

export default function MyProjectsPage() {
	const queryClient = useQueryClient();
	const { data, isLoading, error, refetch } = useQuery({
		queryKey: queryKeys.adminProjectsList({ page: 1, limit: 100 }),
		queryFn: () => adminProjectApi.list({ page: 1, limit: 100 }),
	});
	const deleteMutation = useMutation({
		mutationFn: (projectId: number) => adminProjectApi.delete(projectId),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminProjects }),
	});
	const changeRequestsQuery = useQuery({
		queryKey: queryKeys.changeRequests,
		queryFn: () => changeRequestApi.listMine({ limit: 20 }),
	});
	const deleteProject = (id: number, title: string) => {
		if (window.confirm(`“${title}” 작품을 삭제하시겠습니까?\n\n삭제된 작품과 연결된 파일은 복구할 수 없습니다.`)) {
			deleteMutation.mutate(id);
		}
	};

	if (isLoading) return <LoadingSpinner />;
	if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;

	const projects = data?.items ?? [];

	return (
		<div className="admin-projects-page">
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<span className="admin-page-header__eyebrow">My Projects</span>
					<h1>내 작품</h1>
				</div>
				<Link to="/me/projects/new" className="btn btn--primary">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '0.4rem' }}>
						<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
					</svg>
					새 작품 제출
				</Link>
			</div>

			{projects.length === 0 ? (
				<EmptyState message="등록한 작품이 없습니다." />
			) : (
				<>
					<div className="admin-card admin-desktop-only">
						<table className="admin-table">
							<thead>
								<tr>
									<th>제목</th>
									<th>연도</th>
									<th>상태</th>
									<th>누락</th>
									<th>참여 학생</th>
									<th>수정일</th>
									<th>관리</th>
								</tr>
							</thead>
							<tbody>
								{projects.map((p) => (
									<tr key={p.id}>
										<td className="admin-table__title-cell"><strong>{p.title}</strong></td>
										<td><span className="admin-year-badge">{p.year}</span></td>
										<td>
											<span className={`badge ${STATUS_COLORS[p.status]}`}>
												{STATUS_LABELS[p.status]}
											</span>
										</td>
										<td>{p.isIncomplete && <span className="incomplete-badge">불완전</span>}</td>
										<td>{p.memberNames.length > 0 ? p.memberNames.join(', ') : '-'}</td>
										<td className="text-muted">{new Date(p.updatedAt).toLocaleDateString('ko-KR')}</td>
										<td>
											{p.canEdit || p.canDelete ? (
												<>
													{p.canEdit && <Link to={`/admin/projects/${p.id}/edit`} className="btn btn--small btn--secondary">수정</Link>}
													{p.canDelete && <button type="button" className="btn btn--small btn--danger" disabled={deleteMutation.isPending} onClick={() => deleteProject(p.id, p.title)}>삭제</button>}
												</>
											) : p.canRequestChange ? (
												<Link to={`/me/projects/${p.id}/change-request`} className="btn btn--small btn--secondary">변경 요청</Link>
											) : <span className="text-muted">변경 불가</span>}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>

					<div className="admin-mobile-cards">
						{projects.map((p) => (
							<div key={p.id} className="admin-pcard">
								<Link to={p.canEdit ? `/admin/projects/${p.id}/edit` : `/me/projects/${p.id}/change-request`} className="admin-pcard__link">
									<div className="admin-pcard__top">
										<h3 className="admin-pcard__title">{p.title}</h3>
										{p.isIncomplete && <span className="incomplete-badge">불완전</span>}
										<span className={`badge ${STATUS_COLORS[p.status]}`}>
											{STATUS_LABELS[p.status]}
										</span>
									</div>
									<div className="admin-pcard__meta">
										<span className="admin-year-badge">{p.year}</span>
										<span className="admin-pcard__dot">&middot;</span>
										<span>{p.memberNames.length > 0 ? p.memberNames.join(', ') : '-'}</span>
										<span className="admin-pcard__dot">&middot;</span>
										<span>{new Date(p.updatedAt).toLocaleDateString('ko-KR')}</span>
									</div>
								</Link>
								{p.canDelete && <button type="button" className="btn btn--danger btn--small" disabled={deleteMutation.isPending} onClick={() => deleteProject(p.id, p.title)}>삭제</button>}
							</div>
						))}
					</div>
				</>
			)}
			{changeRequestsQuery.data && changeRequestsQuery.data.items.length > 0 && (
				<section className="admin-card" style={{ marginTop: '1.5rem' }}>
					<h2>변경 요청 이력 <span className="text-muted">(최근 20건)</span></h2>
					<ul className="member-list">
						{changeRequestsQuery.data.items.map((request) => (
							<li key={request.id}><Link to={`/me/change-requests/${request.id}`}>{request.projectTitle} · {request.kind === 'DELETE' ? '삭제' : '수정'} · {request.state} · {new Date(request.updatedAt).toLocaleDateString('ko-KR')}</Link></li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
