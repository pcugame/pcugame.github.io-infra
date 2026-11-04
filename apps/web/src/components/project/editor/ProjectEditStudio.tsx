import type { ComponentProps, ReactNode } from 'react';
import { ProjectStudio } from './ProjectStudio';

export function ProjectEditStudio({ introduction, game, files, detail, ...props }: Omit<ComponentProps<typeof ProjectStudio>, 'panels'> & {
	introduction: ReactNode; game: ReactNode; files: ReactNode; detail: ReactNode;
}) {
	return <ProjectStudio {...props} panels={[introduction, game, files, detail]} />;
}
