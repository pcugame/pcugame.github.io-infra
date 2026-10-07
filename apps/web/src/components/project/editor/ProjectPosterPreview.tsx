import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../ui';
import type { ResponsiveImage as ImageData } from '@pcu/contracts';
import { ResponsiveImage } from '../../common';
import { isPdf } from '../../../lib/upload/project-files';

function PosterPlaceholder({ hidden = false }: { hidden?: boolean }) {
	return (
		<img
			src={`${import.meta.env.BASE_URL}poster-placeholder.svg`}
			alt="포스터 플레이스홀더"
			aria-hidden={hidden}
			className="admin-project-edit-poster__image"
		/>
	);
}

function LocalPosterPreview({ file, title }: { file: File; title: string }) {
	const image = useRef<HTMLImageElement>(null);
	const [loadedFile, setLoadedFile] = useState<File | null>(null);
	useEffect(() => {
		const url = URL.createObjectURL(file);
		if (image.current) image.current.src = url;
		return () => URL.revokeObjectURL(url);
	}, [file]);
	const loaded = loadedFile === file;
	return (
		<div className="admin-project-edit-poster__preview">
			<PosterPlaceholder hidden={loaded} />
			<img
				ref={image}
				alt={`${title} 포스터`}
				aria-hidden={!loaded}
				className="admin-project-edit-poster__actual"
				style={{ opacity: loaded ? 1 : 0 }}
				onLoad={() => setLoadedFile(file)}
				onError={() => setLoadedFile(null)}
			/>
		</div>
	);
}

function PosterImage({
	image,
	title,
	localFile,
}: {
	image?: ImageData;
	title: string;
	localFile?: File | null;
}) {
	const [loadedImage, setLoadedImage] = useState<string | null>(null);
	const identity = image ? JSON.stringify(image) : null;
	const loaded = !localFile && identity !== null && loadedImage === identity;
	if (localFile && !isPdf(localFile)) return <LocalPosterPreview file={localFile} title={title} />;
	return (
		<div className="admin-project-edit-poster__preview">
			<PosterPlaceholder hidden={loaded} />
			{!localFile && image && (
				<ResponsiveImage
					key={identity}
					image={image}
					alt={`${title} 포스터`}
					aria-hidden={!loaded}
					className="admin-project-edit-poster__actual"
					style={{ opacity: loaded ? 1 : 0 }}
					sizes="(max-width: 700px) 100vw, 320px"
					onLoad={() => setLoadedImage(identity)}
					onError={() => setLoadedImage(null)}
				/>
			)}
		</div>
	);
}

/** Native modal provides focus containment, Escape and focus restoration. */
export function ProjectPosterPreview(props: { image?: ImageData; title: string; localFile?: File | null; trigger?: ReactNode; triggerClassName?: string }) {
	const [expanded, setExpanded] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	const canExpand = props.localFile ? !isPdf(props.localFile) : !!props.image;
	useEffect(() => {
		if (!expanded) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		dialog.current?.showModal();
		return () => {
			document.body.style.overflow = previousOverflow;
		};
	}, [expanded]);
	return (
		<div className="project-poster-preview">
			{!props.trigger && <PosterImage {...props} />}
			{canExpand && (
				<Button variant="secondary" size="small" className={props.triggerClassName} onClick={() => setExpanded(true)} aria-haspopup="dialog" aria-label={props.trigger ? `${props.title} 포스터 확대` : undefined}>
					{props.trigger ?? '포스터 확대'}
				</Button>
			)}
			{props.localFile && isPdf(props.localFile) && (
				<p className="field-hint">PDF 포스터 · 업로드 처리 후 미리보기가 표시됩니다.</p>
			)}
			{expanded &&
				createPortal(
					<dialog
						ref={dialog}
						className="project-poster-dialog"
						aria-label={`${props.title} 포스터 확대`}
						onClose={() => setExpanded(false)}
						onKeyDown={(event) => {
							if (event.key === 'Tab') {
								event.preventDefault();
								event.currentTarget.querySelector('button')?.focus();
							}
						}}
						onClick={(event) => {
							if (event.target === event.currentTarget) dialog.current?.close();
						}}
					>
						<Button variant="secondary" onClick={() => dialog.current?.close()} autoFocus>
							닫기
						</Button>
						<PosterImage {...props} />
					</dialog>,
					document.body,
				)}
		</div>
	);
}
