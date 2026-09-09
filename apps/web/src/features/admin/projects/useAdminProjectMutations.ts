import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdminProjectDetail, ProjectStatus, SetProjectVideoOrderRequest, UpdateMemberRequest } from '@pcu/contracts';

import type { AddMemberInput, UpdateProjectFormInput } from '../../../contracts/schemas';
import { adminAssetApi, adminMemberApi, adminProjectApi } from '../../../lib/api';
import { queryKeys } from '../../../lib/query';

interface UseAdminProjectMutationsParams {
	projectId: number;
	project?: AdminProjectDetail;
	onMemberAdded?: () => void;
}

export function useAdminProjectMutations({
	projectId,
	project,
	onMemberAdded,
}: UseAdminProjectMutationsParams) {
	const qc = useQueryClient();

	const invalidateProject = () => {
		qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
	};

	const invalidateProjectLists = () => {
		qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
	};

	const invalidatePublicYears = () => {
		qc.invalidateQueries({ queryKey: queryKeys.publicYears });
	};

	const updateMutation = useMutation({
		mutationFn: (data: UpdateProjectFormInput) => adminProjectApi.update(projectId, data),
		onSuccess: () => {
			invalidateProject();
			invalidateProjectLists();
			invalidatePublicYears();
		},
	});

	const addMemberMutation = useMutation({
		mutationFn: (body: AddMemberInput) => adminMemberApi.add(projectId, body),
		onSuccess: () => {
			invalidateProject();
			onMemberAdded?.();
		},
	});

	const updateMemberMutation = useMutation({
		mutationFn: ({ memberId, body }: { memberId: number; body: UpdateMemberRequest }) =>
			adminMemberApi.update(projectId, memberId, body),
		onSuccess: invalidateProject,
	});

	const removeMemberMutation = useMutation({
		mutationFn: (memberId: number) => adminMemberApi.remove(projectId, memberId),
		onSuccess: invalidateProject,
	});

	const swapMemberMutation = useMutation({
		mutationFn: ({ memberIdA, memberIdB }: { memberIdA: number; memberIdB: number }) =>
			adminMemberApi.swap(projectId, memberIdA, memberIdB),
		onSuccess: invalidateProject,
	});

	const setPosterMutation = useMutation({
		mutationFn: (assetId: number) => adminProjectApi.setPoster(projectId, { assetId }),
		onSuccess: () => {
			invalidateProject();
			invalidateProjectLists();
		},
	});

	const removeAssetMutation = useMutation({
		mutationFn: (assetId: number) => adminAssetApi.remove(assetId),
		onSuccess: invalidateProject,
	});

	const removeWebglMutation = useMutation({
		mutationFn: () => adminProjectApi.deleteWebgl(projectId),
		onSuccess: invalidateProject,
	});

	const reorderVideosMutation = useMutation({
		mutationFn: (body: SetProjectVideoOrderRequest) =>
			adminProjectApi.reorderVideos(projectId, body),
		onSuccess: invalidateProject,
		onError: invalidateProject,
	});

	const toggleStatusMutation = useMutation({
		mutationFn: (status: Exclude<ProjectStatus, 'DRAFT'>) => adminProjectApi.update(projectId, { status }),
		onSuccess: () => {
			invalidateProject();
			invalidateProjectLists();
			invalidatePublicYears();
		},
	});

	const swapMemberOrder = (index: number, direction: -1 | 1) => {
		if (!project) return;
		const members = project.members;
		const other = index + direction;
		if (other < 0 || other >= members.length) return;
		swapMemberMutation.mutate({
			memberIdA: members[index].id,
			memberIdB: members[other].id,
		});
	};

	return {
		updateMutation,
		addMemberMutation,
		updateMemberMutation,
		removeMemberMutation,
		swapMemberMutation,
		setPosterMutation,
		removeAssetMutation,
		removeWebglMutation,
		reorderVideosMutation,
		toggleStatusMutation,
		swapMemberOrder,
	};
}
