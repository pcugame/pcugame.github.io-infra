import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
	SubmitProjectPayloadSchema,
	type SubmitProjectPayloadInput,
} from '../../contracts/schemas';
import { adminExhibitionApi } from '../../lib/api';
import { getProjectSubmitApi, type ProjectSubmissionMode } from '../../lib/api/project-submit';
import { queryKeys } from '../../lib/query';
import { buildSubmitFormData } from '../../lib/utils';
import { useMe } from '../auth';
import type { SubmissionFilesState } from './useSubmissionFiles';

interface UseProjectSubmissionFormParams {
	mode: ProjectSubmissionMode;
	files: Pick<SubmissionFilesState, 'posterFile' | 'imageFiles' | 'videoFiles' | 'gameFile' | 'webglFile'>;
}

export function useProjectSubmissionForm({ mode, files }: UseProjectSubmissionFormParams) {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { user } = useMe();
	const isAdminMode = mode === 'admin';
	const isPrivileged = isAdminMode && (user?.role === 'ADMIN' || user?.role === 'OPERATOR');
	const copy = isAdminMode
		? {
				eyebrow: 'Admin Project',
				title: '운영자 작품 등록',
				submitLabel: '작품 등록',
				submittingLabel: '등록 중…',
				gameUploadHint: '작품 등록 후 자동으로 청크 업로드가 시작됩니다. 중간에 끊겨도 이어서 올릴 수 있습니다.',
				webglUploadHint: '게임 ZIP과 별도로 업로드됩니다. ZIP 루트 또는 단일 폴더 아래에 index.html이 있어야 합니다.',
			}
		: {
				eyebrow: 'My Project',
				title: '내 작품 제출',
				submitLabel: '작품 제출',
				submittingLabel: '제출 중…',
				gameUploadHint: '작품 제출 후 자동으로 청크 업로드가 시작됩니다. 중간에 끊겨도 이어서 올릴 수 있습니다.',
				webglUploadHint: '게임 ZIP과 별도로 업로드됩니다. ZIP 루트 또는 단일 폴더 아래에 index.html이 있어야 합니다.',
			};

	const { data: yearsData } = useQuery({
		queryKey: queryKeys.adminExhibitions,
		queryFn: adminExhibitionApi.list,
	});
	const years = yearsData?.items ?? [];

	const form = useForm<SubmitProjectPayloadInput>({
		resolver: zodResolver(SubmitProjectPayloadSchema),
		defaultValues: {
			exhibitionId: 0,
			title: '',
			summary: '',
			description: '',
			members: [
				{
					name: user?.name ?? '',
					studentId: user?.studentId ?? '',
					...(isAdminMode && user?.id ? { userId: user.id } : {}),
				},
			],
		},
	});
	const {
		control,
		getValues,
		setValue,
		formState: { errors },
	} = form;

	const membersFieldArray = useFieldArray({
		control,
		name: 'members',
	});

	useEffect(() => {
		if (!user || membersFieldArray.fields.length === 0) return;

		const firstMember = getValues('members.0');
		if (!firstMember?.name) {
			setValue('members.0.name', user.name, { shouldValidate: true });
		}
		if (!firstMember?.studentId && user.studentId) {
			setValue('members.0.studentId', user.studentId, { shouldValidate: true });
		}
		if (isAdminMode && !firstMember?.userId) {
			setValue('members.0.userId', user.id);
		}
	}, [membersFieldArray.fields.length, getValues, isAdminMode, setValue, user]);

	const selectedExhibitionId = useWatch({ control, name: 'exhibitionId' });
	const selectedYearItem = years.find((year) => year.id === Number(selectedExhibitionId));
	const isUploadLocked = selectedYearItem != null && !selectedYearItem.isUploadEnabled && !isPrivileged;
	const [createdProjectId, setCreatedProjectId] = useState<number | null>(null);

	const submitMutation = useMutation({
		mutationFn: (formData: FormData) => getProjectSubmitApi(mode).submit(formData),
		onSuccess: (res) => {
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
			qc.invalidateQueries({ queryKey: queryKeys.yearProjects(res.year) });

			if (files.gameFile || files.webglFile) {
				setCreatedProjectId(res.id);
			} else {
				navigate(isAdminMode ? `/admin/projects/${res.id}/edit` : '/me/projects');
			}
		},
	});

	const onSubmit = (data: SubmitProjectPayloadInput) => {
		if (isAdminMode && user) {
			const linkedMember = data.members.find((member) => member.name === user.name);
			if (linkedMember) linkedMember.userId = user.id;
		}
		const fd = buildSubmitFormData(data, {
			poster: files.posterFile ?? undefined,
			images: files.imageFiles.length > 0 ? files.imageFiles : undefined,
			videoFiles: files.videoFiles.length > 0 ? files.videoFiles : undefined,
		});
		submitMutation.mutate(fd);
	};

	const goToEdit = useCallback(() => {
		if (!createdProjectId) return;
		navigate(isAdminMode ? `/admin/projects/${createdProjectId}/edit` : '/me/projects');
	}, [createdProjectId, isAdminMode, navigate]);

	return {
		copy,
		createdProjectId,
		errors,
		form,
		goToEdit,
		isSubmitting: submitMutation.isPending,
		isUploadLocked,
		membersFieldArray,
		onSubmit,
		selectedYearItem,
		showGameProgress: createdProjectId !== null,
		submitMutation,
		years,
	};
}
