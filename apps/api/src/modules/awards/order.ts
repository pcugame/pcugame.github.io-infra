import type { AwardLink } from './serialization.js';
export function compareAwardProjects(a: SortableProject, b: SortableProject): number {
 const group = a.exhibition.sortOrder - b.exhibition.sortOrder || a.exhibitionId - b.exhibitionId;
 if (group) return group;
 const rank = (p: SortableProject) => p.awards?.length ? Math.min(...p.awards.map(a => a.award.sortOrder)) : Infinity;
 const ar = rank(a), br = rank(b);
 if (ar !== br) return ar < br ? -1 : 1;
 const poster = (p: SortableProject) => p.poster?.status === 'READY' && p.poster.representations.some(r => r.role === 'ORIGINAL' && r.state === 'READY');
 return Number(poster(b)) - Number(poster(a)) || a.sortOrder - b.sortOrder || a.id - b.id;
}
interface SortableProject {
 id: number; exhibitionId: number; sortOrder: number; exhibition: { sortOrder: number }; awards?: AwardLink[];
 poster: { status: string; representations: { role: string; state: string }[] } | null;
}
