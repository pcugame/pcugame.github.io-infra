import { useEffect, useRef, useState } from 'react';
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

export function ProjectPosterPreview({
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
