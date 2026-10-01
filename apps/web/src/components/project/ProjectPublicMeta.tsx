import { safeExternalLinks } from './externalLinks';
import { ExternalLinkIcon } from './ExternalLinkIcon';
import type { ExternalLink, Platform } from '@pcu/contracts';

type ProjectPublicMetaProps = {
	githubUrl?: string;
	externalLinks?: ExternalLink[];
	platforms?: Platform[];
};

const PLATFORM_LABELS = {
	PC: 'PC',
	WEB: 'WEB',
	MOBILE: 'MOBILE',
} as const satisfies Record<Platform, string>;

export function ProjectPublicMeta({ githubUrl, externalLinks, platforms = [] }: ProjectPublicMetaProps) {
	const links = safeExternalLinks(externalLinks, githubUrl);
	const hasPlatforms = platforms.length > 0;
	if (links.length === 0 && !hasPlatforms) return null;

	return (
		<div className="project-meta" aria-label="작품 메타 정보">
			{hasPlatforms && (
				<div className="project-meta__platforms" aria-label="지원 플랫폼">
					{platforms.map((platform, index) => (
						<span key={`${platform}-${index}`} className="project-meta__platform-chip">
							{PLATFORM_LABELS[platform]}
						</span>
					))}
				</div>
			)}

			{links.map((link, index) => (
				<a
					key={index}
					className="project-github-link project-external-link"
					href={link.url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={`${link.label} 링크 열기`}
					title={`${link.label} 링크`}
				><ExternalLinkIcon url={link.url} service={link.service} /><span>{link.label}</span></a>
			))}
		</div>
	);
}
