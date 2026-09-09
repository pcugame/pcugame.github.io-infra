import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
	SubmitProjectPayloadSchema,
	type SubmitProjectPayloadInput,
} from '../../contracts/schemas';
import { adminExhibitionApi, isApiError } from '../../lib/api';
import { getProjectSubmitApi, type ProjectSubmissionMode } from '../../lib/api/project-submit';
import { queryKeys } from '../../lib/query';
import { buildSubmitFormData } from '../../lib/utils';
import {
	createIdempotencyFingerprint,
	fingerprintFile,
	useStableIdempotencyOperation,
} from '../../lib/idempotency-operation';
import { useMe } from '../auth';
import type { SubmissionFilesState } from './useSubmissionFiles';
import type { ProjectSubmissionManifestItem, ProjectSubmissionItemStatus, SubmitProjectResponse } from '../../contracts';

interface UseProjectSubmissionFormParams {
	mode: ProjectSubmissionMode;
	files: Pick<SubmissionFilesState, 'posterFile' | 'imageFiles' | 'videoFiles' | 'documentFiles' | 'attachmentFiles' | 'gameFile' | 'webglFile'>;
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
	const isUploadLocked = selectedYearItem != null && !(selectedYearItem.isModificationEnabled ?? selectedYearItem.isUploadEnabled) && !isPrivileged;
	const [createdProjectId, setCreatedProjectId] = useState<number | null>(null);
	const [createdSubmission, setCreatedSubmission] = useState<SubmitProjectResponse | null>(null);
	const [submissionItems, setSubmissionItems] = useState<ProjectSubmissionItemStatus[]>([]);
	const [submissionError, setSubmissionError] = useState<unknown>(null);
	const manifestByFingerprint = useRef(new Map<string, ProjectSubmissionManifestItem[]>());
	const publicationPollActive = useRef(false);
	const pendingStorageKey = `pcu.pending-project-submission:${mode}`;
	const idempotencyOperation = useStableIdempotencyOperation();

	const finalizeIfReady = useCallback(async (projectId: number) => {
		if (publicationPollActive.current) return false;
		publicationPollActive.current = true;
		try {
			const api = getProjectSubmitApi(mode);
			const deadline = Date.now() + 10 * 60_000;
			for (;;) {
				const status = await api.getSubmission(projectId);
				setSubmissionItems(status.items);
				if (status.state === 'CANCELLED') {
					window.sessionStorage.removeItem(pendingStorageKey);
					setSubmissionError(new Error('Project submission was cancelled'));
					return false;
				}
				if (status.state === 'PUBLISHED') {
					window.sessionStorage.removeItem(pendingStorageKey);
					qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
					qc.invalidateQueries({ queryKey: queryKeys.publicYears });
					navigate(isAdminMode ? `/admin/projects/${projectId}/edit` : '/me/projects');
					return true;
				}
				if (status.publicationState === 'FAILED') {
					setSubmissionError(new Error(status.publicationError ?? 'Project publication failed'));
					return false;
				}
				const failed = status.items.find((item) => item.state === 'FAILED' || item.state === 'CANCELLED');
				if (failed) {
					setSubmissionError(new Error(failed.failureReason ?? `${failed.slot} upload failed`));
					return false;
				}
				if (status.state === 'PENDING') {
					if (!status.items.every((item) => item.state === 'READY')) return false;
					await api.finalizeSubmission(projectId);
				} else if (status.state !== 'FINALIZING') {
					return false;
				}
				if (Date.now() >= deadline) {
					setSubmissionError(new Error('Project publication is taking longer than expected'));
					return false;
				}
				await new Promise((resolve) => setTimeout(resolve, 1_500));
			}
		} catch (error) {
			setSubmissionError(error);
			return false;
		} finally {
			publicationPollActive.current = false;
		}
	}, [isAdminMode, mode, navigate, pendingStorageKey, qc]);

	const cancelSubmission = useCallback(async () => {
		if (createdProjectId === null) return;
		try {
			await getProjectSubmitApi(mode).cancelSubmission(createdProjectId);
			window.sessionStorage.removeItem(pendingStorageKey);
			setCreatedProjectId(null);
			setCreatedSubmission(null);
			setSubmissionItems([]);
			navigate(isAdminMode ? '/admin/projects' : '/me/projects');
		} catch (error) {
			setSubmissionError(error);
		}
	}, [createdProjectId, isAdminMode, mode, navigate, pendingStorageKey]);

	useEffect(() => {
		const raw = window.sessionStorage.getItem(pendingStorageKey);
		if (!raw) return;
		try {
			const restored = JSON.parse(raw) as SubmitProjectResponse;
			if (!restored.id || !restored.submissionId || restored.status !== 'DRAFT') throw new Error('invalid');
			setCreatedSubmission(restored);
			setCreatedProjectId(restored.id);
			setSubmissionItems(restored.items);
			void finalizeIfReady(restored.id);
		} catch {
			window.sessionStorage.removeItem(pendingStorageKey);
		}
	}, [finalizeIfReady, pendingStorageKey]);

	const submitMutation = useMutation({
		mutationFn: ({ formData, idempotencyKey }: {
			formData: FormData;
			idempotencyKey: string;
			fingerprint: string;
		}) => getProjectSubmitApi(mode).submit({ formData, idempotencyKey }),
		retry: (failureCount, error) => failureCount < 1
			&& isApiError(error)
			&& error.status === 0
			&& error.statusText === 'Network Error',
		retryDelay: 0,
		onSuccess: (res, operation) => {
			idempotencyOperation.complete(operation.fingerprint);
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
			qc.invalidateQueries({ queryKey: queryKeys.yearProjects(res.year) });

			setCreatedProjectId(res.id);
			setCreatedSubmission(res);
			setSubmissionItems(res.items);
			window.sessionStorage.setItem(pendingStorageKey, JSON.stringify(res));
			void finalizeIfReady(res.id);
		},
	});

	const onSubmit = (data: SubmitProjectPayloadInput) => {
		if (isAdminMode && user) {
			const linkedMember = data.members.find((member) => member.name === user.name);
			if (linkedMember) linkedMember.userId = user.id;
		}
		// New clients submit metadata first. GAME/WEBGL/VIDEO/POSTER/IMAGE bytes
		// subsequently use Garage multipart capabilities after project identity
		// exists; the inline multipart API is a Phase-1 legacy bridge only.
		const fingerprint = createIdempotencyFingerprint({
			mode,
			payload: data,
			files: {
				poster: files.posterFile ? fingerprintFile(files.posterFile) : null,
				images: files.imageFiles.map(fingerprintFile),
				videos: files.videoFiles.map(fingerprintFile),
				documents: files.documentFiles.map(fingerprintFile),
				attachments: files.attachmentFiles.map(fingerprintFile),
				game: files.gameFile ? fingerprintFile(files.gameFile) : null,
				webgl: files.webglFile ? fingerprintFile(files.webglFile) : null,
			},
		});
		let manifest = manifestByFingerprint.current.get(fingerprint);
		if (!manifest) {
			const token = () => crypto.randomUUID().replaceAll('-', '');
			const createdManifest: ProjectSubmissionManifestItem[] = [
				...(files.gameFile ? [{ kind: 'GAME' as const, slot: 'game', clientToken: token(), required: true as const }] : []),
				...(files.webglFile ? [{ kind: 'WEBGL' as const, slot: 'webgl', clientToken: token(), required: true as const }] : []),
				...(files.posterFile ? [{ kind: 'POSTER' as const, slot: 'poster', clientToken: token(), required: true as const }] : []),
				...files.videoFiles.map((_file, index) => ({ kind: 'VIDEO' as const, slot: `video:${index}`, clientToken: token(), required: true as const })),
				...files.imageFiles.map((_file, index) => ({ kind: 'IMAGE' as const, slot: `image:${index}`, clientToken: token(), required: true as const })),
				...files.documentFiles.map((_file, index) => ({ kind: 'DOCUMENT' as const, slot: `document:${index}`, clientToken: token(), required: true as const })),
				...files.attachmentFiles.map((_file, index) => ({ kind: 'ATTACHMENT' as const, slot: `attachment:${index}`, clientToken: token(), required: true as const })),
			];
			manifest = createdManifest;
			manifestByFingerprint.current.set(fingerprint, manifest);
		}
		const fd = buildSubmitFormData({ ...data, manifest }, {});
		submitMutation.mutate({
			formData: fd,
			fingerprint,
			idempotencyKey: idempotencyOperation.keyFor(fingerprint),
		});
	};

	const goToEdit = useCallback(() => {
		if (!createdProjectId) return;
		navigate(isAdminMode ? `/admin/projects/${createdProjectId}/edit` : '/me/projects');
	}, [createdProjectId, isAdminMode, navigate]);

	return {
		copy,
		cancelSubmission,
		createdProjectId,
		createdSubmission,
		errors,
		form,
		goToEdit,
		isSubmitting: submitMutation.isPending,
		isUploadLocked,
		finalizeIfReady,
		membersFieldArray,
		onSubmit,
		selectedYearItem,
		showGameProgress: createdProjectId !== null,
		submitMutation,
		submissionError,
		submissionItems,
		years,
	};
}
