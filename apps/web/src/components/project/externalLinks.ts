import { ExternalLinkSchema, type ExternalLink } from '@pcu/contracts';

/** An explicitly empty collection must never revive a removed legacy link. */
export function effectiveExternalLinks(externalLinks?: ExternalLink[], githubUrl?: string): ExternalLink[] {
	if (externalLinks !== undefined) return externalLinks;
	const legacy = ExternalLinkSchema.safeParse({ label: 'GitHub', url: githubUrl });
	return legacy.success ? [legacy.data] : [];
}

export function safeExternalLinks(externalLinks?: ExternalLink[], githubUrl?: string): ExternalLink[] {
	return effectiveExternalLinks(externalLinks, githubUrl).flatMap((link) => {
		const parsed = ExternalLinkSchema.safeParse(link);
		return parsed.success ? [parsed.data] : [];
	});
}
