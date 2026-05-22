import type { PublicProjectCard } from '../../contracts';

export function sortProjectsWithPosterFirst(projects: PublicProjectCard[]): PublicProjectCard[] {
	return projects
		.map((project, index) => ({ project, index }))
		.sort((a, b) => {
			const posterRankA = a.project.posterUrl ? 0 : 1;
			const posterRankB = b.project.posterUrl ? 0 : 1;

			if (posterRankA !== posterRankB) return posterRankA - posterRankB;
			return a.index - b.index;
		})
		.map(({ project }) => project);
}
