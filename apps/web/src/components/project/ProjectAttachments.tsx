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
		<section className={className} aria-label="프로젝트 자료">
			<h3>프로젝트 자료</h3>
			<ul className="project-attachments">
				{attachments.map((attachment) => (
					<li key={attachment.assetId}>
						<a href={attachment.downloadUrl} download>{attachment.originalName}</a>
						<small> {attachment.kind === 'DOCUMENT' ? '문서' : '첨부'} · {formatSize(attachment.sizeBytes)}</small>
					</li>
					))}
			</ul>
		</section>
	);
}
