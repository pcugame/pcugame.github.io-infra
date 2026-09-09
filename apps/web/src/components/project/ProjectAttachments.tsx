import type { ProjectAttachment } from '@pcu/contracts';

function formatSize(bytes: number): string {
	return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectAttachments({ attachments = [], className }: { attachments?: readonly ProjectAttachment[]; className?: string }) {
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
