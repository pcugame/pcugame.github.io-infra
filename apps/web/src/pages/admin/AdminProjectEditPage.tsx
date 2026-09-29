import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { AddMemberInput, UpdateProjectFormInput } from '../../contracts/schemas';
import { LoadingSpinner, ErrorMessage } from '../../components/common';
import {
	AdminProjectAssetManager,
	AdminProjectPosterUpload,
	AdminProjectUploadProvider,
} from '../../features/admin/projects/AdminProjectAssetManager';
import { ProjectEditorLayout } from '../../components/project/editor';
import { AdminProjectBasicInfoForm } from '../../features/admin/projects/AdminProjectBasicInfoForm';
import { AdminProjectMemberEditor } from '../../features/admin/projects/AdminProjectMemberEditor';
import { AdminProjectStatusPanel } from '../../features/admin/projects/AdminProjectStatusPanel';
import { useAdminProjectMutations } from '../../features/admin/projects/useAdminProjectMutations';
import { useMe } from '../../features/auth';
import { adminProjectApi } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { getClientUploadLimits } from '../../lib/upload-limits';

export default function AdminProjectEditPage() {
	const { id: idParam } = useParams<{ id: string }>();
	const id = Number(idParam);
	const { user } = useMe();
	const [newMember, setNewMember] = useState<AddMemberInput>({
		name: '',
		studentId: '',
	});

	const {
		data: project,
		isLoading,
		error,
		refetch,
	} = useQuery({
		queryKey: queryKeys.adminProject(id),
		queryFn: () => adminProjectApi.getDetail(id),
		enabled: !isNaN(id),
	});

	const mutations = useAdminProjectMutations({
		projectId: id,
		project,
		onMemberAdded: () => setNewMember({ name: '', studentId: '' }),
	});

	if (isLoading) return <LoadingSpinner />;
	if (error && !project) return <ErrorMessage error={error} onReset={() => refetch()} />;
	if (!project) return null;

	// Capability is computed at the API boundary.  Operators retain direct access
	// even when an exhibition is closed, while contributors must submit a request.
	const limits = getClientUploadLimits(user?.role ?? 'USER');
	const isPrivileged = user?.role === 'OPERATOR' || user?.role === 'ADMIN';
	const canEditContent = isPrivileged || project.canEdit === true;

	const onSubmitUpdate = (data: UpdateProjectFormInput) => {
		mutations.updateMutation.mutate({
			title: data.title,
			summary: data.summary,
			description: data.description,
			sortOrder: data.sortOrder,
		});
	};

	return (
		<div className="admin-project-edit-page">
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<h1>
						작품 수정
						{project.isIncomplete && <span className="incomplete-badge">불완전</span>}
					</h1>
				</div>
				<AdminProjectStatusPanel
					status={project.status}
					isPrivileged={isPrivileged}
					isPending={mutations.toggleStatusMutation.isPending}
					error={mutations.toggleStatusMutation.error}
					onToggle={mutations.toggleStatusMutation.mutate}
				/>
			</div>
			{!canEditContent && project.canRequestChange && (
				<div className="admin-card" style={{ marginBottom: '1rem' }}>
					<p>이 작품이 속한 연도는 닫혀 있습니다. 변경 내용은 운영자 승인 후 반영됩니다.</p>
					<Link className="btn btn--primary" to={`/me/projects/${id}/change-request`}>
						수정 요청 작성
					</Link>
				</div>
			)}

			<AdminProjectUploadProvider
				key={id}
				project={project}
				projectId={id}
				limits={limits}
				canEditContent={canEditContent}
			>
				<ProjectEditorLayout
					poster={<AdminProjectPosterUpload project={project} canEditContent={canEditContent} />}
					details={
						<>
							<AdminProjectBasicInfoForm
								project={project}
								error={mutations.updateMutation.error}
								isDirtySubmitting={mutations.updateMutation.isPending}
								isSuccess={mutations.updateMutation.isSuccess}
								canEditContent={canEditContent}
								onSubmit={onSubmitUpdate}
							/>

							<AdminProjectMemberEditor
								members={project.members}
								newMember={newMember}
								setNewMember={setNewMember}
								canEditContent={canEditContent}
								isAdding={mutations.addMemberMutation.isPending}
								isBusy={
									mutations.updateMemberMutation.isPending ||
									mutations.removeMemberMutation.isPending ||
									mutations.swapMemberMutation.isPending
								}
								onAdd={mutations.addMemberMutation.mutate}
								onSwap={mutations.swapMemberOrder}
								onUpdate={(memberId, body) => mutations.updateMemberMutation.mutate({ memberId, body })}
								onRemove={mutations.removeMemberMutation.mutate}
							/>
						</>
					}
					files={<AdminProjectAssetManager canEditContent={canEditContent} />}
				/>
			</AdminProjectUploadProvider>
		</div>
	);
}
