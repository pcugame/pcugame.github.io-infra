import { ExternalLinksSchema, type ExternalLink } from '@pcu/contracts';

/** NULL/missing uses the legacy URL. An explicit empty array disables that fallback. */
export function effectiveProjectExternalLinks(project: { externalLinks?: unknown; githubUrl?: string }): ExternalLink[] {
	if (project.externalLinks != null) {
		const parsed = ExternalLinksSchema.safeParse(project.externalLinks);
		return parsed.success ? parsed.data : [];
	}
	const legacy = project.githubUrl?.trim();
	if (!legacy) return [];
	try {
		const url = new URL(legacy);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
		const parsed = ExternalLinksSchema.safeParse([{ label: 'GitHub', url: url.href }]);
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}
