import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UploadZone } from '../../../lib/upload/project-files';

interface Props {
	zone: UploadZone;
	enabled: boolean;
	onFiles: (files: File[]) => void;
	/** Preview and enlargement controls, separate from the file-selection button. */
	children?: ReactNode;
	/** Queue and controls outside the button, within the drop area. */
	footer?: ReactNode;
	hint?: string;
}

export function ProjectUploadDropZone({ zone, enabled, onFiles, children, footer, hint }: Props) {
	const input = useRef<HTMLInputElement>(null);
	const dragDepth = useRef(0);
	const [draggingFiles, setDraggingFiles] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	useEffect(() => {
		let depth = 0;
		const enter = (event: DragEvent) => {
			if (!event.dataTransfer?.types.includes('Files')) return;
			depth++;
			setDraggingFiles(true);
		};
		const leave = () => {
			depth = Math.max(0, depth - 1);
			if (!depth) {
				setDraggingFiles(false);
				dragDepth.current = 0;
				setDragOver(false);
			}
		};
		const reset = () => {
			depth = 0;
			dragDepth.current = 0;
			setDraggingFiles(false);
			setDragOver(false);
		};
		const over = (event: DragEvent) => {
			if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
		};
		const drop = (event: DragEvent) => {
			over(event);
			reset();
		};
		window.addEventListener('dragenter', enter);
		window.addEventListener('dragleave', leave);
		window.addEventListener('dragover', over);
		window.addEventListener('drop', drop);
		window.addEventListener('dragend', reset);
		window.addEventListener('blur', reset);
		return () => {
			window.removeEventListener('dragenter', enter);
			window.removeEventListener('dragleave', leave);
			window.removeEventListener('dragover', over);
			window.removeEventListener('drop', drop);
			window.removeEventListener('dragend', reset);
			window.removeEventListener('blur', reset);
		};
	}, []);
	const poster = zone === 'poster';
	const label = poster ? '포스터 파일 선택' : '게임·미디어·자료 선택';
	const highlighted = enabled && draggingFiles;
	const hovered = highlighted && dragOver;
	return (
		<div
			className={`project-upload-drop project-upload-drop--${zone}${highlighted ? ' is-file-dragging' : ''}${hovered ? ' is-drag-over' : ''}`}
			onDragEnter={(event) => {
				if (!event.dataTransfer.types.includes('Files')) return;
				dragDepth.current++;
				setDragOver(true);
			}}
			onDragLeave={() => {
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (!dragDepth.current) setDragOver(false);
			}}
			onDragOver={(event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
			}}
			onDrop={(event) => {
				event.preventDefault();
				if (enabled) onFiles(Array.from(event.dataTransfer.files));
			}}
		>
			{children}
			<button
				type="button"
				className="project-upload-drop__select"
				disabled={!enabled}
				aria-label={label}
				onClick={() => input.current?.click()}
			>
				{!poster && (
					<svg
						className="project-upload-drop__icon"
						width="48"
						height="48"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
						focusable="false"
					>
						<path d="M12 16V3m-5 5 5-5 5 5" />
						<path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
					</svg>
				)}
				<span className="project-upload-drop__prompt">
					{hovered ? '여기에 놓으세요' : poster ? '포스터를 드래그 앤 드롭' : '파일을 드래그 앤 드롭'}
				</span>
				{enabled && (
					<span className="project-upload-drop__browse">
						{hovered ? '놓아서 파일 선택' : poster ? '포스터 선택·교체' : '파일 선택'}
					</span>
				)}
				<span className="field-hint">
					{hint ??
						(poster
							? 'JPG · PNG · WebP · PDF 한 개'
							: '이미지 · 동영상 · 문서 · 첨부자료 / ZIP은 용도를 선택해 주세요')}
				</span>
			</button>
			<input
				ref={input}
				type="file"
				hidden
				disabled={!enabled}
				aria-label={label}
				multiple={!poster}
				accept={
					poster ? '.jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf' : undefined
				}
				onChange={(event) => {
					if (enabled) onFiles(Array.from(event.target.files ?? []));
					event.target.value = '';
				}}
			/>
			{footer}
		</div>
	);
}
