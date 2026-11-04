import { useQuery } from '@tanstack/react-query';
import { useViewerKey, queryKeys } from '../../lib/query';
import { publicApi } from '../../lib/api';
import { ProjectPresentation } from './ProjectPresentation';

export function ProjectModal({ slug, year, onClose }: { slug: string; year: number; onClose: () => void }) {
 const viewerKey = useViewerKey();
 const { data: project, isLoading } = useQuery({
  queryKey: viewerKey(queryKeys.projectDetail(year, slug)),
  queryFn: () => publicApi.getProjectDetail(slug, year),
  enabled: !!slug,
 });
 return <ProjectPresentation project={project} isLoading={isLoading} onClose={onClose} />;
}
