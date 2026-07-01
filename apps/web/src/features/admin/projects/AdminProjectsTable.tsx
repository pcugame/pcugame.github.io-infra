import type React from 'react';
import { Link } from 'react-router-dom';
import type { AdminProjectItem, AdminProjectListSort, ProjectStatus } from '../../../contracts';

const STATUS_LABELS: Record<ProjectStatus, string> = {
	PUBLISHED: '공개',
	ARCHIVED: '보관',
};

const STATUS_COLORS: Record<ProjectStatus, string> = {
	PUBLISHED: 'badge--published',
	ARCHIVED: 'badge--archived',
};

function titleStyle(title: string): React.CSSProperties {
	const len = title.length;
	if (len <= 16) return { fontSize: '0.9rem', lineHeight: '1.5' };
	if (len <= 24) return { fontSize: '0.82rem', lineHeight: '1.4' };
	if (len <= 36) return { fontSize: '0.74rem', lineHeight: '1.3' };
	return { fontSize: '0.66rem', lineHeight: '1.2', letterSpacing: '-0.02em' };
}

interface AdminProjectsTableProps {
	projects: AdminProjectItem[];
	isPrivileged: boolean;
	selected: Set<number>;
	allSelected: boolean;
	onToggleAll: () => void;
	onToggleOne: (id: number) => void;
	onSort: (key: AdminProjectListSort) => void;
	sortIndicator: (key: AdminProjectListSort) => string;
}

export function AdminProjectsTable({
	projects,
	isPrivileged,
	selected,
	allSelected,
	onToggleAll,
	onToggleOne,
	onSort,
	sortIndicator,
}: AdminProjectsTableProps) {
	return (
		<div className="admin-card admin-desktop-only">
			<table className="admin-table">
				<thead>
					<tr>
						{isPrivileged && (
							<th style={{ width: '2.5rem' }}>
								<input
									type="checkbox"
									checked={allSelected}
									onChange={onToggleAll}
								/>
							</th>
						)}
						<th className="admin-table__sortable" onClick={() => onSort('title')}>
							제목{sortIndicator('title')}
						</th>
						<th className="admin-table__sortable" onClick={() => onSort('year')}>
							연도{sortIndicator('year')}
						</th>
						<th className="admin-table__sortable" onClick={() => onSort('status')}>
							상태{sortIndicator('status')}
						</th>
						<th>누락</th>
						<th>제작자</th>
						<th className="admin-table__col--creator">작성자</th>
						<th>수정일</th>
						<th>관리</th>
					</tr>
				</thead>
				<tbody>
					{projects.map((p) => (
						<tr key={p.id} className={selected.has(p.id) ? 'admin-table__row--selected' : ''}>
							{isPrivileged && (
								<td>
									<input
										type="checkbox"
										checked={selected.has(p.id)}
										onChange={() => onToggleOne(p.id)}
									/>
								</td>
							)}
							<td className="admin-table__title-cell"><strong style={titleStyle(p.title)}>{p.title}</strong></td>
							<td><span className="admin-year-badge">{p.year}</span></td>
							<td>
								<span className={`badge ${STATUS_COLORS[p.status]}`}>
									{STATUS_LABELS[p.status]}
								</span>
							</td>
							<td>
								{p.isIncomplete && (
									<span className="incomplete-badge">불완전</span>
								)}
							</td>
							<td>{p.memberNames.length > 0 ? p.memberNames.join(', ') : '-'}</td>
							<td className="admin-table__col--creator">{p.createdByUserName ?? '-'}</td>
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
	);
}
