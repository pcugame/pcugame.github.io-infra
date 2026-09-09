import type { ProjectAttachment } from '@pcu/contracts';

interface ProjectAttachmentsProps {
	attachments?: readonly ProjectAttachment[];
	className?: string;
}

function formatSize(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Download-only files deliberately have no inline preview or executable path. */
export function ProjectAttachments({ attachments = [], className }: ProjectAttachmentsProps) {
	if (attachments.length === 0) return null;
	return (
		<section className={['project-materials', className].filter(Boolean).join(' ')} aria-label="프로젝트 자료">
			<h3>프로젝트 자료</h3>
			<ul className="project-attachments">
				{attachments.map((attachment) => (
					<li key={attachment.assetId} className="project-attachments__item">
						<div className="project-attachments__info">
							<span className="project-attachments__name">{attachment.originalName}</span>
							<small className="project-attachments__meta">{attachment.kind === 'DOCUMENT' ? '문서' : '첨부'} · {formatSize(attachment.sizeBytes)}</small>
						</div>
						<a className="btn btn--secondary btn--small" href={attachment.downloadUrl} download aria-label={`${attachment.originalName} 다운로드`}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
								<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" />
							</svg>
							다운로드
						</a>
					</li>
				))}
			</ul>
		</section>
	);
}
