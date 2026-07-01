import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import type { AddMemberInput, UpdateProjectFormInput } from '../../contracts/schemas';
import { LoadingSpinner, ErrorMessage } from '../../components/common';
import { AdminProjectAssetManager } from '../../features/admin/projects/AdminProjectAssetManager';
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
	if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;
	if (!project) return null;

	const limits = getClientUploadLimits(user?.role ?? 'USER');
	const canEditContent = true;
	const isPrivileged = user?.role === 'OPERATOR' || user?.role === 'ADMIN';

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
			</div>
			<p className="edit-meta">
				슬러그: <code>{project.slug}</code> | 연도: <span className="admin-year-badge">{project.year}</span>
				{project.isIncomplete && ' | 불완전 자료'}
			</p>

			<AdminProjectBasicInfoForm
				project={project}
				error={mutations.updateMutation.error}
				isDirtySubmitting={mutations.updateMutation.isPending}
				isSuccess={mutations.updateMutation.isSuccess}
				onSubmit={onSubmitUpdate}
			/>

			<div className="project-form">
				<AdminProjectStatusPanel
					status={project.status}
					isPrivileged={isPrivileged}
					isPending={mutations.toggleStatusMutation.isPending}
					error={mutations.toggleStatusMutation.error}
					onToggle={mutations.toggleStatusMutation.mutate}
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
					onUpdate={(memberId, body) =>
						mutations.updateMemberMutation.mutate({ memberId, body })
					}
					onRemove={mutations.removeMemberMutation.mutate}
				/>

				<AdminProjectAssetManager
					project={project}
					projectId={id}
					limits={limits}
					canEditContent={canEditContent}
					addAssetError={mutations.addAssetMutation.error}
					isAddingAsset={mutations.addAssetMutation.isPending}
					isSettingPoster={mutations.setPosterMutation.isPending}
					isRemovingAsset={mutations.removeAssetMutation.isPending}
					onAddAsset={mutations.addAsset}
					onSetPoster={mutations.setPosterMutation.mutate}
					onRemoveAsset={mutations.removeAssetMutation.mutate}
				/>
			</div>
		</div>
	);
}
