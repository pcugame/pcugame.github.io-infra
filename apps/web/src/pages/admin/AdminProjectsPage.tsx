import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ProjectStatus } from '../../contracts';
import { adminProjectApi } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';

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

export default function AdminProjectsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.adminProjects,
    queryFn: adminProjectApi.list,
  });

  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'ALL'>('ALL');

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;

  const projects = data?.items ?? [];
  const filtered =
    statusFilter === 'ALL'
      ? projects
      : projects.filter((p) => p.status === statusFilter);

  const statusCounts = {
    ALL: projects.length,
    DRAFT: projects.filter((p) => p.status === 'DRAFT').length,
    PUBLISHED: projects.filter((p) => p.status === 'PUBLISHED').length,
    ARCHIVED: projects.filter((p) => p.status === 'ARCHIVED').length,
  };

  return (
    <div className="admin-projects-page">
      <div className="admin-page-header">
        <div className="admin-page-header__text">
          <span className="admin-page-header__eyebrow">Project Management</span>
          <h1>작품 관리</h1>
        </div>
        <Link to="/admin/projects/new" className="btn btn--primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '0.4rem' }}>
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          새 작품 등록
        </Link>
      </div>

      {/* 상태 필터 탭 */}
      <div className="admin-filter-tabs">
        {(['ALL', 'DRAFT', 'PUBLISHED', 'ARCHIVED'] as const).map((s) => (
          <button
            key={s}
            className={`admin-filter-tab ${statusFilter === s ? 'admin-filter-tab--active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s === 'ALL' ? '전체' : STATUS_LABELS[s]}
            <span className="admin-filter-tab__count">{statusCounts[s]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState message="조건에 맞는 작품이 없습니다." />
      ) : (
        <>
          {/* Desktop: table */}
          <div className="admin-card admin-desktop-only">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>제목</th>
                  <th>연도</th>
                  <th>상태</th>
                  <th>작성자</th>
                  <th>수정일</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.title}</strong></td>
                    <td><span className="admin-year-badge">{p.year}</span></td>
                    <td>
                      <span className={`badge ${STATUS_COLORS[p.status]}`}>
                        {STATUS_LABELS[p.status]}
                      </span>
                    </td>
                    <td>{p.createdByUserName ?? '-'}</td>
                    <td className="text-muted">{new Date(p.updatedAt).toLocaleDateString('ko-KR')}</td>
                    <td>
                      <Link
                        to={`/admin/projects/${p.id}/edit`}
                        className="btn btn--small btn--secondary"
                      >
                        수정
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: card list */}
          <div className="admin-mobile-cards">
            {filtered.map((p) => (
              <Link
                to={`/admin/projects/${p.id}/edit`}
                key={p.id}
                className="admin-pcard"
              >
                <div className="admin-pcard__top">
                  <h3 className="admin-pcard__title">{p.title}</h3>
                  <span className={`badge ${STATUS_COLORS[p.status]}`}>
                    {STATUS_LABELS[p.status]}
                  </span>
                </div>
                <div className="admin-pcard__meta">
                  <span className="admin-year-badge">{p.year}</span>
                  <span className="admin-pcard__dot">&middot;</span>
                  <span>{p.createdByUserName ?? '-'}</span>
                  <span className="admin-pcard__dot">&middot;</span>
                  <span>{new Date(p.updatedAt).toLocaleDateString('ko-KR')}</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
