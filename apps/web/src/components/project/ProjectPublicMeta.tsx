import type { Platform } from '../../contracts';

type ProjectPublicMetaProps = {
	githubUrl?: string;
	platforms?: Platform[];
};

const PLATFORM_LABELS = {
	PC: 'PC',
	WEB: 'WEB',
	MOBILE: 'MOBILE',
} as const satisfies Record<Platform, string>;

function toSafeHttpUrl(rawUrl?: string): string | undefined {
	const trimmed = rawUrl?.trim();
	if (!trimmed) return undefined;

	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function GitHubMark() {
	return (
		<svg className="project-github-link__icon" viewBox="0 0 16 16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M8 0C3.58 0 0 3.67 0 8.2c0 3.62 2.29 6.69 5.47 7.77.4.08.55-.18.55-.4v-1.4c-2.23.5-2.7-.98-2.7-.98-.36-.95-.89-1.2-.89-1.2-.73-.51.06-.5.06-.5.8.06 1.22.85 1.22.85.72 1.25 1.88.89 2.34.68.07-.53.28-.89.5-1.09-1.78-.21-3.64-.91-3.64-4.05 0-.9.31-1.63.82-2.2-.08-.2-.36-1.04.08-2.17 0 0 .67-.22 2.2.84A7.45 7.45 0 0 1 8 4.08c.68 0 1.36.09 2 .27 1.52-1.06 2.19-.84 2.19-.84.44 1.13.16 1.97.08 2.17.51.57.82 1.3.82 2.2 0 3.15-1.87 3.84-3.65 4.04.29.26.54.76.54 1.53v2.27c0 .22.14.48.55.4A8.18 8.18 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"
			/>
		</svg>
	);
}

export function ProjectPublicMeta({ githubUrl, platforms = [] }: ProjectPublicMetaProps) {
	const safeGithubUrl = toSafeHttpUrl(githubUrl);
	const hasPlatforms = platforms.length > 0;
	if (!safeGithubUrl && !hasPlatforms) return null;

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

			{safeGithubUrl && (
				<a
					className="project-github-link"
					href={safeGithubUrl}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="GitHub 링크 열기"
					title="GitHub 링크"
				>
					<GitHubMark />
				</a>
			)}
		</div>
	);
}
