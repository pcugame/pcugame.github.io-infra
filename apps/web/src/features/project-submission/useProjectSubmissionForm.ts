import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InlineAssetKind } from '@pcu/contracts';

import {
	SubmitProjectPayloadSchema,
	type SubmitProjectPayloadInput,
} from '../../contracts/schemas';
import { adminExhibitionApi, isApiError } from '../../lib/api';
import { getProjectSubmitApi, type ProjectSubmissionMode } from '../../lib/api/project-submit';
import { queryKeys } from '../../lib/query';
import { buildAssetFormData } from '../../lib/utils';
import {
	createIdempotencyFingerprint,
	useStableIdempotencyOperation,
} from '../../lib/idempotency-operation';
import { useMe } from '../auth';
import type { SubmissionFilesState } from './useSubmissionFiles';

export interface InlineSubmissionUpload {
	id: string;
	kind: InlineAssetKind;
	file: File;
	status: 'pending' | 'uploading' | 'ready' | 'failed';
	error?: unknown;
}

interface UseProjectSubmissionFormParams {
	mode: ProjectSubmissionMode;
	files: Pick<SubmissionFilesState, 'posterFile' | 'imageFiles' | 'gameFile' | 'webglFile'>;
}

export function useProjectSubmissionForm({ mode, files }: UseProjectSubmissionFormParams) {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { user } = useMe();
	const isAdminMode = mode === 'admin';
	const isPrivileged = isAdminMode && (user?.role === 'ADMIN' || user?.role === 'OPERATOR');
	const projectApi = getProjectSubmitApi(mode);
	const copy = isAdminMode
		? {
				eyebrow: 'Admin Project',
				title: '운영자 작품 등록',
				submitLabel: '작품 등록',
				submittingLabel: '메타데이터 등록 중…',
				gameUploadHint: '작품 등록 후 브라우저에서 저장소로 direct multipart 업로드합니다.',
				webglUploadHint: '게임 ZIP과 별도의 direct multipart 세션을 사용합니다.',
			}
		: {
				eyebrow: 'My Project',
				title: '내 작품 제출',
				submitLabel: '작품 제출',
				submittingLabel: '메타데이터 등록 중…',
				gameUploadHint: '작품 제출 후 브라우저에서 저장소로 direct multipart 업로드합니다.',
				webglUploadHint: '게임 ZIP과 별도의 direct multipart 세션을 사용합니다.',
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
			members: [{
				name: user?.name ?? '',
				studentId: user?.studentId ?? '',
				...(isAdminMode && user?.id ? { userId: user.id } : {}),
			}],
		},
	});
	const { control, getValues, setValue, formState: { errors } } = form;
	const membersFieldArray = useFieldArray({ control, name: 'members' });

	useEffect(() => {
		if (!user || membersFieldArray.fields.length === 0) return;
		const firstMember = getValues('members.0');
		if (!firstMember?.name) setValue('members.0.name', user.name, { shouldValidate: true });
		if (!firstMember?.studentId && user.studentId) {
			setValue('members.0.studentId', user.studentId, { shouldValidate: true });
		}
		if (isAdminMode && !firstMember?.userId) setValue('members.0.userId', user.id);
	}, [membersFieldArray.fields.length, getValues, isAdminMode, setValue, user]);

	const selectedExhibitionId = useWatch({ control, name: 'exhibitionId' });
	const selectedYearItem = years.find((year) => year.id === Number(selectedExhibitionId));
	const isUploadLocked = selectedYearItem != null && !selectedYearItem.isUploadEnabled && !isPrivileged;
	const [createdProjectId, setCreatedProjectId] = useState<number | null>(null);
	const [inlineUploads, setInlineUploads] = useState<InlineSubmissionUpload[]>([]);
	const idempotencyOperation = useStableIdempotencyOperation();

	const uploadInlineAsset = useCallback(async (
		projectId: number,
		item: InlineSubmissionUpload,
	) => {
		setInlineUploads((current) => current.map((candidate) => candidate.id === item.id
			? { ...candidate, status: 'uploading', error: undefined }
			: candidate));
		try {
			await projectApi.addAsset({
				projectId,
				formData: buildAssetFormData(item.kind, item.file),
				idempotencyKey: item.id,
			});
			setInlineUploads((current) => current.map((candidate) => candidate.id === item.id
				? { ...candidate, status: 'ready', error: undefined }
				: candidate));
		} catch (error) {
			setInlineUploads((current) => current.map((candidate) => candidate.id === item.id
				? { ...candidate, status: 'failed', error }
				: candidate));
		}
	}, [projectApi]);

	const uploadInlineAssets = useCallback(async (
		projectId: number,
		items: InlineSubmissionUpload[],
	) => {
		// One-at-a-time keeps total API ingress, temp disk and transform memory bounded.
		for (const item of items) await uploadInlineAsset(projectId, item);
	}, [uploadInlineAsset]);

	const submitMutation = useMutation({
		mutationFn: ({ payload, idempotencyKey }: {
			payload: SubmitProjectPayloadInput;
			idempotencyKey: string;
			fingerprint: string;
		}) => projectApi.submit({ payload, idempotencyKey }),
		retry: (failureCount, error) => failureCount < 1
			&& isApiError(error) && error.status === 0 && error.statusText === 'Network Error',
		retryDelay: 0,
		onSuccess: (res, operation) => {
			idempotencyOperation.complete(operation.fingerprint);
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
			qc.invalidateQueries({ queryKey: queryKeys.yearProjects(res.year) });
			const items: InlineSubmissionUpload[] = [
				...(files.posterFile ? [{
					id: crypto.randomUUID(),
					kind: 'POSTER' as const,
					file: files.posterFile,
					status: 'pending' as const,
				}] : []),
				...files.imageFiles.map((file) => ({
					id: crypto.randomUUID(),
					kind: 'IMAGE' as const,
					file,
					status: 'pending' as const,
				})),
			];
			setCreatedProjectId(res.id);
			setInlineUploads(items);
			void uploadInlineAssets(res.id, items);
		},
	});

	const onSubmit = (data: SubmitProjectPayloadInput) => {
		const payload = { ...data, members: data.members.map((member) => ({ ...member })) };
		if (isAdminMode && user) {
			const linkedMember = payload.members.find((member) => member.name === user.name);
			if (linkedMember) linkedMember.userId = user.id;
		}
		const fingerprint = createIdempotencyFingerprint({ mode, payload });
		submitMutation.mutate({
			payload,
			fingerprint,
			idempotencyKey: idempotencyOperation.keyFor(fingerprint),
		});
	};

	const retryInlineUpload = useCallback((item: InlineSubmissionUpload) => {
		if (!createdProjectId) return;
		void uploadInlineAsset(createdProjectId, item);
	}, [createdProjectId, uploadInlineAsset]);
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
		inlineUploads,
		inlineUploadsComplete: inlineUploads.every((item) => item.status === 'ready'),
		isSubmitting: submitMutation.isPending,
		isUploadLocked,
		membersFieldArray,
		onSubmit,
		retryInlineUpload,
		selectedYearItem,
		showGameProgress: createdProjectId !== null,
		submitMutation,
		years,
	};
}
