import { ProjectSubmissionStudio } from '../features/project-submission/studio/ProjectSubmissionStudio';

export default function ProjectSubmissionStudioPage() {
	return <ProjectSubmissionStudio mode="user" />;
}

export function AdminProjectSubmissionStudioPage() {
	return <ProjectSubmissionStudio mode="admin" />;
}
