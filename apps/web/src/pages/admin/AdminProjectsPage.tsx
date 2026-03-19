import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { adminProjectApi } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';
import type { ProjectStatus } from '../../contracts';
import { useState } from 'react';

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

  return (
    <div className="admin-projects-page">
      <div className="admin-page-header">
        <h1>작품 관리</h1>
        <Link to="/admin/projects/new" className="btn btn--primary">
          새 작품 등록
        </Link>
      </div>

      {/* 상태 필터 */}
      <div className="filter-bar">
        <label>상태 필터:</label>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ProjectStatus | 'ALL')}
        >
          <option value="ALL">전체</option>
          <option value="DRAFT">초안</option>
          <option value="PUBLISHED">공개</option>
          <option value="ARCHIVED">보관</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState message="조건에 맞는 작품이 없습니다." />
      ) : (
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
                <td>{p.title}</td>
                <td>{p.year}</td>
                <td>
                  <span className={`badge ${STATUS_COLORS[p.status]}`}>
                    {STATUS_LABELS[p.status]}
                  </span>
                </td>
                <td>{p.createdByUserName ?? '-'}</td>
                <td>{new Date(p.updatedAt).toLocaleDateString('ko-KR')}</td>
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
      )}
    </div>
  );
}
