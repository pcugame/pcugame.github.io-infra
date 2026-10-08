import type { ComponentProps, ReactNode } from 'react';
import { ProjectStudio } from './ProjectStudio';

export function ProjectEditStudio({ introduction, game, files, detail, settings, after, ...props }: Omit<ComponentProps<typeof ProjectStudio>, 'panels'> & {
	introduction: ReactNode; game: ReactNode; files: ReactNode; detail: ReactNode; settings?: ReactNode;
}) {
	return <ProjectStudio {...props} panels={[introduction, game, files, detail]} after={<>{settings && <div className="submission-studio__settings" hidden={props.step !== 2} inert={props.step !== 2}>{settings}</div>}{after}</>} />;
}
