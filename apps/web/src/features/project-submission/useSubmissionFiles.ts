import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, RefObject } from 'react';

import type { ClientUploadLimits, MaterialUploadLimits } from '../../lib/upload-limits';
import type { ProjectUploadKind } from '../../lib/upload/project-files';
import {
	findOversizedAssetFile,
	formatFileSizeMb,
	getAssetLimitMb,
	isPdfFile,
} from '../../lib/upload/fileValidation';

interface UseSubmissionFilesParams {
	limits: ClientUploadLimits;
	materialLimits?: MaterialUploadLimits;
}

export interface SubmissionFilesState {
	posterFile: File | null;
	imageFiles: File[];
	gameFile: File | null;
	webglFile: File | null;
	videoFiles: File[];
	documentFiles: File[];
	attachmentFiles: File[];
	posterPreview: string | null;
	fileSizeError: string | null;
	posterInputRef: RefObject<HTMLInputElement | null>;
	imagesInputRef: RefObject<HTMLInputElement | null>;
	gameInputRef: RefObject<HTMLInputElement | null>;
	webglInputRef: RefObject<HTMLInputElement | null>;
	videoInputRef: RefObject<HTMLInputElement | null>;
	documentsInputRef: RefObject<HTMLInputElement | null>;
	attachmentsInputRef: RefObject<HTMLInputElement | null>;
	clearPoster: () => void;
	clearImages: () => void;
	clearGameFile: () => void;
	clearWebglFile: () => void;
	clearVideo: () => void;
	clearDocuments: () => void;
	clearAttachments: () => void;
	handlePosterChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleImagesChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleGameChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleWebglChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleVideoChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleDocumentsChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleAttachmentsChange: (e: ChangeEvent<HTMLInputElement>) => void;
	selectPoster: (file: File | null) => boolean;
	addFiles: (files: readonly { kind: Exclude<ProjectUploadKind, 'POSTER'>; file: File }[]) => boolean;
	removeFile: (kind: ProjectUploadKind, file: File) => void;
}

const mb = 1024 * 1024;
const MAX_PROJECT_VIDEOS = 5;

export function useSubmissionFiles({
	limits,
	materialLimits,
}: UseSubmissionFilesParams): SubmissionFilesState {
	const [posterFile, setPosterFile] = useState<File | null>(null);
	const [imageFiles, setImageFiles] = useState<File[]>([]);
	const [gameFile, setGameFile] = useState<File | null>(null);
	const [webglFile, setWebglFile] = useState<File | null>(null);
	const [videoFiles, setVideoFiles] = useState<File[]>([]);
	const [documentFiles, setDocumentFiles] = useState<File[]>([]);
	const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
	const [posterPreview, setPosterPreview] = useState<string | null>(null);
	const [fileSizeError, setFileSizeError] = useState<string | null>(null);
	const posterPreviewRef = useRef<string | null>(null);
	const posterInputRef = useRef<HTMLInputElement>(null);
	const imagesInputRef = useRef<HTMLInputElement>(null);
	const gameInputRef = useRef<HTMLInputElement>(null);
	const webglInputRef = useRef<HTMLInputElement>(null);
	const videoInputRef = useRef<HTMLInputElement>(null);
	const documentsInputRef = useRef<HTMLInputElement>(null);
	const attachmentsInputRef = useRef<HTMLInputElement>(null);

	const revokePosterPreview = () => {
		if (posterPreviewRef.current) {
			URL.revokeObjectURL(posterPreviewRef.current);
			posterPreviewRef.current = null;
		}
	};

	const clearPoster = () => {
		revokePosterPreview();
		setPosterFile(null);
		setPosterPreview(null);
		if (posterInputRef.current) posterInputRef.current.value = '';
	};

	const clearImages = () => {
		setImageFiles([]);
		if (imagesInputRef.current) imagesInputRef.current.value = '';
	};

	const clearGameFile = () => {
		setGameFile(null);
		if (gameInputRef.current) gameInputRef.current.value = '';
	};

	const clearWebglFile = () => {
		setWebglFile(null);
		if (webglInputRef.current) webglInputRef.current.value = '';
	};

	const clearVideo = () => {
		setVideoFiles([]);
		if (videoInputRef.current) videoInputRef.current.value = '';
	};
	const clearDocuments = () => {
		setDocumentFiles([]);
		if (documentsInputRef.current) documentsInputRef.current.value = '';
	};

	const clearAttachments = () => {
		setAttachmentFiles([]);
		if (attachmentsInputRef.current) attachmentsInputRef.current.value = '';
	};

	useEffect(() => revokePosterPreview, []);

	const checkFileSize = (file: File, maxMb: number, label: string): boolean => {
		if (file.size > maxMb * mb) {
			setFileSizeError(`${label}: ${formatFileSizeMb(file.size)}MB — 최대 ${maxMb}MB까지 허용됩니다.`);
			return false;
		}
		setFileSizeError(null);
		return true;
	};

	const selectPoster = (file: File | null) => {
		revokePosterPreview();
		const isPdf = !!file && isPdfFile(file);
		const limitMb = file ? getAssetLimitMb('POSTER', file, limits) : limits.posterMaxMb;
		if (file && !checkFileSize(file, limitMb, '포스터')) {
			setPosterFile(null);
			setPosterPreview(null);
			return false;
		}
		setPosterFile(file);
		if (file && !isPdf) {
			const url = URL.createObjectURL(file);
			posterPreviewRef.current = url;
			setPosterPreview(url);
		} else {
			setPosterPreview(null);
		}
		return true;
	};
	const handlePosterChange = (e: ChangeEvent<HTMLInputElement>) => {
		if (!selectPoster(e.target.files?.[0] ?? null)) e.target.value = '';
	};

	const handleImagesChange = (e: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		const oversized = findOversizedAssetFile('IMAGE', files, limits);
		if (oversized) {
			const limitMb = getAssetLimitMb('IMAGE', oversized, limits);
			setFileSizeError(
				`이미지 "${oversized.name}": ${formatFileSizeMb(oversized.size)}MB — 최대 ${limitMb}MB까지 허용됩니다.`,
			);
			setImageFiles([]);
			e.target.value = '';
			return;
		}
		setFileSizeError(null);
		setImageFiles(files);
	};

	const handleGameChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0] ?? null;
		if (file && file.size > limits.gameMaxMb * mb) {
			setFileSizeError(
				`게임 파일: ${formatFileSizeMb(file.size)}MB — 최대 ${limits.gameMaxMb}MB까지 허용됩니다.`,
			);
			setGameFile(null);
			e.target.value = '';
			return;
		}
		setFileSizeError(null);
		setGameFile(file);
	};

	const handleWebglChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0] ?? null;
		if (file && file.size > limits.gameMaxMb * mb) {
			setFileSizeError(
				`WebGL 빌드: ${formatFileSizeMb(file.size)}MB — 최대 ${limits.gameMaxMb}MB까지 허용됩니다.`,
			);
			setWebglFile(null);
			e.target.value = '';
			return;
		}
		setFileSizeError(null);
		setWebglFile(file);
	};

	const handleVideoChange = (e: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		if (videoFiles.length + files.length > MAX_PROJECT_VIDEOS) {
			setFileSizeError(`동영상은 프로젝트당 최대 ${MAX_PROJECT_VIDEOS}개까지 선택할 수 있습니다.`);
			e.target.value = '';
			return;
		}
		const oversized = findOversizedAssetFile('VIDEO', files, limits);
		if (oversized) {
			setFileSizeError(
				`동영상 "${oversized.name}": ${formatFileSizeMb(oversized.size)}MB — 최대 ${getAssetLimitMb('VIDEO', oversized, limits)}MB까지 허용됩니다.`,
			);
			e.target.value = '';
			return;
		}
		setFileSizeError(null);
		if (files.length > 0) {
			setVideoFiles((prev) => [...prev, ...files]);
		}
		e.target.value = '';
	};
	const addMaterials = (
		kind: '문서' | '첨부자료',
		files: File[],
		target: 'documents' | 'attachments',
		input: HTMLInputElement,
	) => {
		if (!materialLimits) {
			setFileSizeError('현재 서버는 프로젝트 자료 업로드를 지원하지 않습니다.');
			input.value = '';
			return;
		}
		const current = documentFiles.length + attachmentFiles.length;
		if (current + files.length > materialLimits.maxCount) {
			setFileSizeError(
				`문서와 첨부자료는 합쳐서 프로젝트당 최대 ${materialLimits.maxCount}개까지 선택할 수 있습니다.`,
			);
			input.value = '';
			return;
		}
		const oversized = files.find((file) => file.size > materialLimits.maxBytes);
		if (oversized) {
			setFileSizeError(
				`${kind} "${oversized.name}": ${formatFileSizeMb(oversized.size)}MB — 파일당 최대 ${formatFileSizeMb(materialLimits.maxBytes)}MB까지 허용됩니다.`,
			);
			input.value = '';
			return;
		}
		setFileSizeError(null);
		if (target === 'documents') setDocumentFiles((previous) => [...previous, ...files]);
		else setAttachmentFiles((previous) => [...previous, ...files]);
		input.value = '';
	};

	const handleDocumentsChange = (e: ChangeEvent<HTMLInputElement>) => {
		addMaterials('문서', Array.from(e.target.files ?? []), 'documents', e.target);
	};

	const handleAttachmentsChange = (e: ChangeEvent<HTMLInputElement>) => {
		addMaterials('첨부자료', Array.from(e.target.files ?? []), 'attachments', e.target);
	};
	const addFiles: SubmissionFilesState['addFiles'] = (selected) => {
		const grouped = (kind: ProjectUploadKind) =>
			selected.filter((item) => item.kind === kind).map((item) => item.file);
		const videos = grouped('VIDEO');
		const documents = grouped('DOCUMENT');
		const attachments = grouped('ATTACHMENT');
		if (grouped('GAME').length > 1 || grouped('WEBGL').length > 1) {
			setFileSizeError('게임과 WebGL 빌드는 각각 ZIP 한 개씩 선택할 수 있습니다.');
			return false;
		}
		if (videoFiles.length + videos.length > MAX_PROJECT_VIDEOS) {
			setFileSizeError(`동영상은 프로젝트당 최대 ${MAX_PROJECT_VIDEOS}개까지 선택할 수 있습니다.`);
			return false;
		}
		if (documents.length + attachments.length > 0) {
			if (!materialLimits) {
				setFileSizeError('현재 서버는 프로젝트 자료 업로드를 지원하지 않습니다.');
				return false;
			}
			if (
				documentFiles.length + attachmentFiles.length + documents.length + attachments.length >
				materialLimits.maxCount
			) {
				setFileSizeError(
					`문서와 첨부자료는 합쳐서 프로젝트당 최대 ${materialLimits.maxCount}개까지 선택할 수 있습니다.`,
				);
				return false;
			}
		}
		for (const { kind, file } of selected) {
			const material = kind === 'DOCUMENT' || kind === 'ATTACHMENT';
			const maxBytes = material
				? materialLimits!.maxBytes
				: (kind === 'GAME' || kind === 'WEBGL' ? limits.gameMaxMb : getAssetLimitMb(kind, file, limits)) * mb;
			if (file.size === 0 || file.size > maxBytes) {
				setFileSizeError(
					`"${file.name}": 빈 파일은 선택할 수 없으며 파일당 최대 ${formatFileSizeMb(maxBytes)}MB까지 허용됩니다.`,
				);
				return false;
			}
		}
		setFileSizeError(null);
		setImageFiles((previous) => [...previous, ...grouped('IMAGE')]);
		setVideoFiles((previous) => [...previous, ...videos]);
		setDocumentFiles((previous) => [...previous, ...documents]);
		setAttachmentFiles((previous) => [...previous, ...attachments]);
		if (grouped('GAME')[0]) setGameFile(grouped('GAME')[0]!);
		if (grouped('WEBGL')[0]) setWebglFile(grouped('WEBGL')[0]!);
		return true;
	};
	const removeFile: SubmissionFilesState['removeFile'] = (kind, file) => {
		if (kind === 'POSTER') clearPoster();
		else if (kind === 'GAME') clearGameFile();
		else if (kind === 'WEBGL') clearWebglFile();
		else if (kind === 'IMAGE')
			setImageFiles((previous) => previous.filter((candidate) => candidate !== file));
		else if (kind === 'VIDEO')
			setVideoFiles((previous) => previous.filter((candidate) => candidate !== file));
		else if (kind === 'DOCUMENT')
			setDocumentFiles((previous) => previous.filter((candidate) => candidate !== file));
		else setAttachmentFiles((previous) => previous.filter((candidate) => candidate !== file));
		setFileSizeError(null);
	};

	return {
		posterFile,
		imageFiles,
		gameFile,
		webglFile,
		videoFiles,
		documentFiles,
		attachmentFiles,
		posterPreview,
		fileSizeError,
		posterInputRef,
		imagesInputRef,
		gameInputRef,
		webglInputRef,
		videoInputRef,
		documentsInputRef,
		attachmentsInputRef,
		clearPoster,
		clearImages,
		clearGameFile,
		clearWebglFile,
		clearVideo,
		clearDocuments,
		clearAttachments,
		handlePosterChange,
		handleImagesChange,
		handleGameChange,
		handleWebglChange,
		handleVideoChange,
		handleDocumentsChange,
		handleAttachmentsChange,
		selectPoster,
		addFiles,
		removeFile,
	};
}
