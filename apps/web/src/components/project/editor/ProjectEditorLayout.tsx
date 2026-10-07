import type { ReactNode } from 'react';

interface Props {
	poster: ReactNode;
	details: ReactNode;
	files: ReactNode;
	actions?: ReactNode;
}

/** Shared responsive layout for editing, registration, and staged change requests. */
export function ProjectEditorLayout({ poster, details, files, actions }: Props) {
	return (
		<>
			<div className="admin-project-edit-grid">
				<div className="project-form admin-project-edit-details">{details}</div>
				<div className="admin-project-edit-media">
					<div className="project-form admin-project-edit-poster">{poster}</div>
					<div className="project-form admin-project-edit-assets">{files}</div>
				</div>
			</div>
			{actions}
		</>
	);
}
