import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
	SubmitProjectPayloadSchema,
	type SubmitProjectPayloadInput,
} from '../../contracts/schemas';
import { adminExhibitionApi, isApiError, getApiErrorCode, getApiErrorMessage } from '../../lib/api';
import { getProjectSubmitApi, type ProjectSubmissionMode } from '../../lib/api/project-submit';
import { queryKeys, useViewerKey, invalidateVisibilityQueries } from '../../lib/query';
import { buildSubmitFormData } from '../../lib/utils';
import {
	createIdempotencyFingerprint,
	fingerprintFile,
	useStableIdempotencyOperation,
} from '../../lib/idempotency-operation';
import { useMe } from '../auth';
import { isFacultyAccount } from './faculty-account';
import type { SubmissionFilesState } from './useSubmissionFiles';
import type { ProjectSubmissionManifestItem, ProjectSubmissionItemStatus, SubmitProjectResponse } from '../../contracts';

interface UseProjectSubmissionFormParams {
	mode: ProjectSubmissionMode;
	files: Pick<SubmissionFilesState, 'posterFile' | 'imageFiles' | 'videoFiles' | 'documentFiles' | 'attachmentFiles' | 'gameFile' | 'webglFile'>;
}

export function useProjectSubmissionForm({ mode, files }: UseProjectSubmissionFormParams) {
	const navigate = useNavigate();
	const viewerKey = useViewerKey();
	const qc = useQueryClient();
	const { user } = useMe();
	const isAdminMode = mode === 'admin';
	const canPrefillParticipant = !isFacultyAccount(user?.email);
	const isPrivileged = isAdminMode && (user?.role === 'ADMIN' || user?.role === 'OPERATOR');
	const copy = isAdminMode
		? {
				eyebrow: 'Admin Project',
				title: '운영자 작품 등록',
				submitLabel: '작품 등록',
				submittingLabel: '등록 중…',
				gameUploadHint: '게임 실행에 필요한 파일을 ZIP으로 압축해 선택하세요.',
				webglUploadHint: 'WebGL ZIP의 최상위 또는 단일 폴더에 index.html과 Build 폴더를 포함하세요. Build에는 .loader.js와 .framework.js, .wasm, .data 파일이 필요합니다. 비압축, .gz, .br, Decompression Fallback의 .unityweb 형식을 지원합니다. loader는 .js(.gz/.br 포함) 형식이어야 합니다. 표시 크기는 업로드 후 자동으로 감지하며, 작품 수정 화면에서 확인·변경할 수 있습니다.',
			}
		: {
				eyebrow: 'My Project',
				title: '내 작품 제출',
				submitLabel: '작품 제출',
				submittingLabel: '제출 중…',
				gameUploadHint: '게임 실행에 필요한 파일을 ZIP으로 압축해 선택하세요.',
				webglUploadHint: 'WebGL ZIP의 최상위 또는 단일 폴더에 index.html과 Build 폴더를 포함하세요. Build에는 .loader.js와 .framework.js, .wasm, .data 파일이 필요합니다. 비압축, .gz, .br, Decompression Fallback의 .unityweb 형식을 지원합니다. loader는 .js(.gz/.br 포함) 형식이어야 합니다. 표시 크기는 업로드 후 자동으로 감지하며, 작품 수정 화면에서 확인·변경할 수 있습니다.',
			};

	const exhibitionsQuery = useQuery({
		queryKey: viewerKey(queryKeys.adminExhibitions),
		queryFn: adminExhibitionApi.list,
	});
	const years = exhibitionsQuery.data?.items ?? [];

	const form = useForm<SubmitProjectPayloadInput>({
		resolver: zodResolver(SubmitProjectPayloadSchema),
		defaultValues: {
			exhibitionId: 0,
			visibility: 'PUBLIC',
			title: '',
			summary: '',
			description: '',
			externalLinks: [],
			platforms: [],
			hardwareRequirements: '',
			members: [
				{
					name: canPrefillParticipant ? user?.name ?? '' : '',
					studentId: canPrefillParticipant ? user?.studentId ?? '' : '',
					...(canPrefillParticipant && isAdminMode && user?.id ? { userId: user.id } : {}),
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

	// Follow the original row through swaps; never autofill a replacement after deletion.
	const initialMemberId = useRef(membersFieldArray.fields[0]?.id);
	useEffect(() => {
		if (!canPrefillParticipant || !user) return;
		const index = membersFieldArray.fields.findIndex(field => field.id === initialMemberId.current);
		if (index < 0) return;
		const member = getValues(`members.${index}`);
		if (!member?.name) {
			setValue(`members.${index}.name`, user.name, { shouldValidate: true });
		}
		if (!member?.studentId && user.studentId) {
			setValue(`members.${index}.studentId`, user.studentId, { shouldValidate: true });
		}
		if (isAdminMode && !member?.userId) {
			setValue(`members.${index}.userId`, user.id);
		}
	}, [canPrefillParticipant, membersFieldArray.fields, getValues, isAdminMode, setValue, user]);

	const selectedExhibitionId = useWatch({ control, name: 'exhibitionId' });
	const selectedYearItem = years.find((year) => year.id === Number(selectedExhibitionId));
	const isUploadLocked = selectedYearItem != null && !(selectedYearItem.isModificationEnabled ?? selectedYearItem.isUploadEnabled) && !isPrivileged;
	const [createdProjectId, setCreatedProjectId] = useState<number | null>(null);
	const [createdSubmission, setCreatedSubmission] = useState<(SubmitProjectResponse & { fileNames?: Record<string, string> }) | null>(null);
	const [submissionItems, setSubmissionItems] = useState<ProjectSubmissionItemStatus[]>([]);
	const [submissionError, setSubmissionError] = useState<unknown>(null);
	const manifestByFingerprint = useRef(new Map<string, ProjectSubmissionManifestItem[]>());
	const publicationPoll = useRef<AbortController | null>(null);
	const mounted = useRef(true);
	const cancellationPending = useRef(false);
	const pendingStorageKey = user ? `pcu.pending-project-submission:${mode}:${user.id}` : null;
	const viewerIdentity = `${mode}:${user?.id ?? 'anonymous'}:${user?.role ?? ''}`;
	const currentViewer = useRef(viewerIdentity); currentViewer.current = viewerIdentity;
	const lifetime = useRef(0);
	useEffect(() => {
		mounted.current = true; cancellationPending.current = false; lifetime.current += 1;
		return () => { mounted.current = false; lifetime.current += 1; publicationPoll.current?.abort(); publicationPoll.current = null; };
	}, [viewerIdentity]);
	const [canRetryStatus, setCanRetryStatus] = useState(false);
	const [canRetryPublication, setCanRetryPublication] = useState(false);
	const [isFinalizing, setIsFinalizing] = useState(false);
	const idempotencyOperation = useStableIdempotencyOperation();

	const finalizeIfReady = useCallback(async (projectId: number, options: { retryPublication?: boolean } = {}) => {
		if (!mounted.current || currentViewer.current !== viewerIdentity || cancellationPending.current || !pendingStorageKey || publicationPoll.current) return false;
		const controller = new AbortController(); publicationPoll.current = controller;
		const operationLifetime = lifetime.current;
		const current = () => mounted.current && lifetime.current === operationLifetime && !controller.signal.aborted && currentViewer.current === viewerIdentity;
		setIsFinalizing(true); setSubmissionError(null); setCanRetryStatus(false);
		try {
			const api = getProjectSubmitApi(mode);
			const deadline = Date.now() + 10 * 60_000;
			let retryPublication = import.meta.env.VITE_MOCK === 'true' && options.retryPublication === true;
			for (;;) {
				const status = await api.getSubmission(projectId);
				if (!current()) return false;
				setSubmissionItems(status.items);
				if (status.publicationState !== 'FAILED') setCanRetryPublication(false);
				if (status.state === 'CANCELLED') {
					window.sessionStorage.removeItem(pendingStorageKey);
					setSubmissionError(new Error('Project submission was cancelled'));
					return false;
				}
				if (status.state === 'PUBLISHED') {
					window.sessionStorage.removeItem(pendingStorageKey);
					qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
					void invalidateVisibilityQueries(qc);
					navigate(`/admin/projects/${projectId}/edit`);
					return true;
				}
				if (status.publicationState === 'FAILED') {
					if (!retryPublication || !status.items.every(item => item.state === 'READY')) {
						setCanRetryPublication(import.meta.env.VITE_MOCK === 'true' && status.items.every(item => item.state === 'READY'));
						setSubmissionError(new Error(status.publicationError ?? 'Project publication failed'));
						return false;
					}
					retryPublication = false;
					await api.finalizeSubmission(projectId);
					if (!current()) return false;
					setCanRetryPublication(false);
				} else {
					const failed = status.items.find(item => item.state === 'FAILED' || item.state === 'CANCELLED');
					if (failed) { setSubmissionError(new Error(failed.failureReason ?? `${failed.slot} upload failed`)); return false; }
					if (status.state === 'PENDING') {
						if (!status.items.every(item => item.state === 'READY')) return false;
						await api.finalizeSubmission(projectId);
						if (!current()) return false;
					} else if (status.state !== 'FINALIZING') return false;
				}
				if (Date.now() >= deadline) { setCanRetryStatus(true); setSubmissionError(new Error('Project publication is taking longer than expected')); return false; }
				await new Promise<void>(resolve => {
					const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
					const timer = setTimeout(finish, 1_500);
					controller.signal.addEventListener('abort', finish, { once: true });
				});
				if (!current()) return false;
			}
		} catch (error) {
			if (!current()) return false;
			if (isApiError(error) && (error.status === 404 || (error.status === 400 && getApiErrorCode(error) === 'ERROR' && getApiErrorMessage(error) === 'Project submission not found'))) {
				window.sessionStorage.removeItem(pendingStorageKey);
				setCreatedProjectId(null); setCreatedSubmission(null); setSubmissionItems([]); setSubmissionError(null);
			} else { setCanRetryStatus(isApiError(error) && (error.status === 0 || error.status === 429 || error.status >= 500)); setSubmissionError(error); }
			return false;
		} finally {
			if (publicationPoll.current === controller) publicationPoll.current = null;
			if (current()) setIsFinalizing(false);
		}
	}, [mode, navigate, pendingStorageKey, qc, viewerIdentity]);

	const cancelSubmission = useCallback(async () => {
		if (!mounted.current || currentViewer.current !== viewerIdentity || cancellationPending.current || createdProjectId === null) return;
		cancellationPending.current = true;
		const operationLifetime = lifetime.current; const operationPoll = publicationPoll.current;
		operationPoll?.abort(); if (publicationPoll.current === operationPoll) publicationPoll.current = null; setIsFinalizing(false);
		const current = () => mounted.current && lifetime.current === operationLifetime && currentViewer.current === viewerIdentity;
		try {
			await getProjectSubmitApi(mode).cancelSubmission(createdProjectId);
			if (pendingStorageKey) { const saved = window.sessionStorage.getItem(pendingStorageKey); try { if (saved && JSON.parse(saved).id === createdProjectId) window.sessionStorage.removeItem(pendingStorageKey); } catch { /* Unrelated malformed pointer is handled by restoration. */ } }
			if (!current()) return;
			operationPoll?.abort(); if (publicationPoll.current === operationPoll) publicationPoll.current = null;
			setCreatedProjectId(null);
			setCreatedSubmission(null);
			setSubmissionItems([]);
			setSubmissionError(null);
		} catch (error) {
			if (current()) setSubmissionError(error);
		} finally { if (current()) cancellationPending.current = false; }
	}, [createdProjectId, mode, pendingStorageKey, viewerIdentity]);

	useEffect(() => {
		setCreatedProjectId(null); setCreatedSubmission(null); setSubmissionItems([]); setSubmissionError(null); setCanRetryPublication(false); setCanRetryStatus(false); setIsFinalizing(false);
		if (!pendingStorageKey) return;
		const raw = window.sessionStorage.getItem(pendingStorageKey);
		if (raw) {
			try {
				const restored = JSON.parse(raw) as SubmitProjectResponse;
				if (!restored.id || !restored.submissionId || restored.status !== 'DRAFT') throw new Error('invalid');
				setCreatedSubmission(restored); setCreatedProjectId(restored.id); setSubmissionItems(restored.items);
				void finalizeIfReady(restored.id);
			} catch { window.sessionStorage.removeItem(pendingStorageKey); }
		}
		return () => { publicationPoll.current?.abort(); publicationPoll.current = null; };
	}, [finalizeIfReady, pendingStorageKey, viewerIdentity]);

	const submitMutation = useMutation({
		mutationFn: ({ formData, idempotencyKey }: {
			fileNames: Record<string, string>;
			formData: FormData;
			idempotencyKey: string;
			fingerprint: string;
			viewerIdentity: string;
			storageKey: string;
			lifetime: number;
		}) => getProjectSubmitApi(mode).submit({ formData, idempotencyKey }),
		retry: (failureCount, error) => failureCount < 1
			&& isApiError(error)
			&& error.status === 0
			&& error.statusText === 'Network Error',
		retryDelay: 0,
		onSuccess: (res, operation) => {
			const active = mounted.current && lifetime.current === operation.lifetime && currentViewer.current === operation.viewerIdentity;
			if (active || window.sessionStorage.getItem(operation.storageKey) === null) window.sessionStorage.setItem(operation.storageKey, JSON.stringify({ ...res, fileNames: operation.fileNames }));
			if (!active) return;
			idempotencyOperation.complete(operation.fingerprint);
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			void invalidateVisibilityQueries(qc);
			qc.invalidateQueries({ queryKey: queryKeys.yearProjects(res.year) });

			setCreatedProjectId(res.id);
			setCreatedSubmission({ ...res, fileNames: operation.fileNames });
			setSubmissionItems(res.items);
			void finalizeIfReady(res.id);
		},
	});

	const onSubmit = (data: SubmitProjectPayloadInput) => {
		if (!mounted.current || currentViewer.current !== viewerIdentity || !pendingStorageKey) return;
		if (canPrefillParticipant && isAdminMode && user) {
			const linkedMember = data.members.find((member) => member.name === user.name);
			if (linkedMember) linkedMember.userId = user.id;
		}
		// Submit metadata first. GAME/WEBGL/VIDEO/POSTER/IMAGE bytes then use
		// Garage multipart capabilities after project identity exists.
		const fingerprint = createIdempotencyFingerprint({
			mode,
			viewerIdentity,
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
			fileNames: Object.fromEntries([
                ...(files.posterFile ? [['poster', files.posterFile.name]] : []),
                ...(files.gameFile ? [['game', files.gameFile.name]] : []),
                ...(files.webglFile ? [['webgl', files.webglFile.name]] : []),
                ...files.imageFiles.map((file, index) => [`image:${index}`, file.name]),
                ...files.videoFiles.map((file, index) => [`video:${index}`, file.name]),
                ...files.documentFiles.map((file, index) => [`document:${index}`, file.name]),
                ...files.attachmentFiles.map((file, index) => [`attachment:${index}`, file.name]),
            ]),
			formData: fd,
			viewerIdentity,
			storageKey: pendingStorageKey,
			lifetime: lifetime.current,
			fingerprint,
			idempotencyKey: idempotencyOperation.keyFor(fingerprint),
		});
	};

	const goToEdit = useCallback(() => {
		if (!createdProjectId) return;
		navigate(`/admin/projects/${createdProjectId}/edit`);
	}, [createdProjectId, navigate]);

	return {
		copy,
		exhibitionsQuery,
		canRetryPublication,
		canRetryStatus,
		retryStatus: () => createdProjectId !== null && finalizeIfReady(createdProjectId),
		isFinalizing,
		retryPublication: () => createdProjectId !== null && finalizeIfReady(createdProjectId, { retryPublication: true }),
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
