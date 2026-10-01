import { z } from 'zod';

export const ExternalLinkServiceSchema = z.enum(['youtube', 'google-drive', 'github', 'itch-io', 'steam', 'notion', 'discord']);
export type ExternalLinkService = z.infer<typeof ExternalLinkServiceSchema>;

const SERVICE_HOSTS: Readonly<Record<string, ExternalLinkService>> = {
	'youtube.com': 'youtube', 'www.youtube.com': 'youtube', 'm.youtube.com': 'youtube',
	'music.youtube.com': 'youtube', 'youtu.be': 'youtube',
	'youtube-nocookie.com': 'youtube', 'www.youtube-nocookie.com': 'youtube',
	'drive.google.com': 'google-drive', 'docs.google.com': 'google-drive',
	'github.com': 'github', 'www.github.com': 'github', 'gist.github.com': 'github',
	'itch.io': 'itch-io', 'www.itch.io': 'itch-io',
	'store.steampowered.com': 'steam', 'steamcommunity.com': 'steam', 'www.steamcommunity.com': 'steam',
	's.team': 'steam',
	'notion.so': 'notion', 'www.notion.so': 'notion', 'notion.site': 'notion', 'www.notion.site': 'notion',
	'notion.com': 'notion', 'www.notion.com': 'notion', 'app.notion.com': 'notion', 'app.notion.so': 'notion',
	'discord.com': 'discord', 'www.discord.com': 'discord', 'discord.gg': 'discord',
	'discordapp.com': 'discord', 'www.discordapp.com': 'discord',
};

/** Local classification only. Never fetches or changes the destination URL. */
export function detectExternalLinkService(value: string): ExternalLinkService | null {
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
		const host = url.hostname.toLowerCase().replace(/\.$/, '');
		if (Object.hasOwn(SERVICE_HOSTS, host)) return SERVICE_HOSTS[host];
		// These services publish user pages on a single tenant label below their official domain.
		if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.itch\.io$/.test(host)) return 'itch-io';
		if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.notion\.site$/.test(host)) return 'notion';
		return null;
	} catch {
		return null;
	}
}

export const ExternalLinkSchema = z.object({
	label: z.string().trim().min(1, '링크 이름을 입력하세요.').max(80, '링크 이름은 80자 이하여야 합니다.'),
	url: z.string().trim().max(2000, '주소는 2,000자 이하여야 합니다.').pipe(
		z.url({ protocol: /^https?$/, error: 'http 또는 https로 시작하는 올바른 주소를 입력하세요.' }),
	),
	service: ExternalLinkServiceSchema.optional(),
}).strict();

export const ExternalLinksSchema = z.array(ExternalLinkSchema).max(20, '외부 링크는 최대 20개까지 추가할 수 있습니다.');
export type ExternalLink = z.infer<typeof ExternalLinkSchema>;
