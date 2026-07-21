import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, RefObject } from 'react';

import type { ClientUploadLimits } from '../../lib/upload-limits';
import {
	findOversizedAssetFile,
	formatFileSizeMb,
	getAssetLimitMb,
	isPdfFile,
} from '../../lib/upload/fileValidation';

interface UseSubmissionFilesParams {
	limits: ClientUploadLimits;
}

export interface SubmissionFilesState {
	posterFile: File | null;
	imageFiles: File[];
	gameFile: File | null;
	webglFile: File | null;
	videoFiles: File[];
	posterPreview: string | null;
	fileSizeError: string | null;
	posterInputRef: RefObject<HTMLInputElement | null>;
	imagesInputRef: RefObject<HTMLInputElement | null>;
	gameInputRef: RefObject<HTMLInputElement | null>;
	webglInputRef: RefObject<HTMLInputElement | null>;
	videoInputRef: RefObject<HTMLInputElement | null>;
	clearPoster: () => void;
	clearImages: () => void;
	clearGameFile: () => void;
	clearWebglFile: () => void;
	clearVideo: () => void;
	handlePosterChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleImagesChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleGameChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleWebglChange: (e: ChangeEvent<HTMLInputElement>) => void;
	handleVideoChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

const mb = 1024 * 1024;

export function useSubmissionFiles({ limits }: UseSubmissionFilesParams): SubmissionFilesState {
	const [posterFile, setPosterFile] = useState<File | null>(null);
	const [imageFiles, setImageFiles] = useState<File[]>([]);
	const [gameFile, setGameFile] = useState<File | null>(null);
	const [webglFile, setWebglFile] = useState<File | null>(null);
	const [videoFiles, setVideoFiles] = useState<File[]>([]);
	const [posterPreview, setPosterPreview] = useState<string | null>(null);
	const [fileSizeError, setFileSizeError] = useState<string | null>(null);
	const posterPreviewRef = useRef<string | null>(null);
	const posterInputRef = useRef<HTMLInputElement>(null);
	const imagesInputRef = useRef<HTMLInputElement>(null);
	const gameInputRef = useRef<HTMLInputElement>(null);
	const webglInputRef = useRef<HTMLInputElement>(null);
	const videoInputRef = useRef<HTMLInputElement>(null);

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

	useEffect(() => revokePosterPreview, []);

	const checkFileSize = (file: File, maxMb: number, label: string): boolean => {
		if (file.size > maxMb * mb) {
			setFileSizeError(
				`${label}: ${formatFileSizeMb(file.size)}MB — 최대 ${maxMb}MB까지 허용됩니다.`,
			);
			return false;
		}
		setFileSizeError(null);
		return true;
	};

	const handlePosterChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0] ?? null;
		revokePosterPreview();
		const isPdf = !!file && isPdfFile(file);
		const limitMb = file ? getAssetLimitMb('POSTER', file, limits) : limits.posterMaxMb;
		if (file && !checkFileSize(file, limitMb, '포스터')) {
			setPosterFile(null);
			setPosterPreview(null);
			e.target.value = '';
			return;
		}
		setPosterFile(file);
		if (file && !isPdf) {
			const url = URL.createObjectURL(file);
			posterPreviewRef.current = url;
			setPosterPreview(url);
		} else {
			setPosterPreview(null);
		}
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

	return {
		posterFile,
		imageFiles,
		gameFile,
		webglFile,
		videoFiles,
		posterPreview,
		fileSizeError,
		posterInputRef,
		imagesInputRef,
		gameInputRef,
		webglInputRef,
		videoInputRef,
		clearPoster,
		clearImages,
		clearGameFile,
		clearWebglFile,
		clearVideo,
		handlePosterChange,
		handleImagesChange,
		handleGameChange,
		handleWebglChange,
		handleVideoChange,
	};
}
