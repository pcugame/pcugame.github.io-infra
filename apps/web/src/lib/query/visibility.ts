import { useMe } from '../../features/auth';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

export function useViewerKey() {
 const { user, isPending } = useMe();
 const viewer = isPending ? 'pending' : user ? `${user.id}:${user.role}` : 'anonymous';
 return (key: QueryKey): QueryKey => [...key, { viewer }];
}
const visibilityRoots = new Set(['publicYears', 'yearProjects', 'exhibitionProjects', 'projectDetail', 'projectDetailById', 'adminExhibitions', 'adminProject', 'adminProjects', 'myProjects', 'changeRequests', 'fileAccess']);
export async function invalidateVisibilityQueries(client: QueryClient, options: { preserveProjectDrafts?: boolean } = {}) {
 // Applying staged edits must retain the mounted editor until its domains finish.
 // The editor refetches its hydrated detail at completion; inactive copies are removed.
 const shouldReset = (root: unknown) => visibilityRoots.has(String(root)) && !(options.preserveProjectDrafts && root === 'adminProject');
 await client.cancelQueries({ predicate: (query) => shouldReset(query.queryKey[0]) });
 client.removeQueries({ predicate: (query) => visibilityRoots.has(String(query.queryKey[0])) && query.getObserversCount() === 0 });
 await client.resetQueries({ predicate: (query) => shouldReset(query.queryKey[0]) });
}
