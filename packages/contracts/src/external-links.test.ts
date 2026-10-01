import { describe, expect, it } from 'vitest';
import { detectExternalLinkService, ExternalLinksSchema, ProjectChangeValuesSchema, SubmitProjectPayloadBaseSchema, UpdateProjectBaseSchema } from './index.js';

const links = [{ label: ' GitHub ', url: ' https://github.com/pcu/game ' }, { label: '홈페이지', url: 'http://example.test/game' }];
const expected = [{ label: 'GitHub', url: 'https://github.com/pcu/game' }, links[1]];

describe('external link contracts', () => {
	it('normalizes labels and addresses consistently across all writes', () => {
		expect(ExternalLinksSchema.parse(links)).toEqual(expected);
		expect(SubmitProjectPayloadBaseSchema.parse({ exhibitionId: 1, title: 'Game', members: [{ name: 'Author', studentId: '1' }], externalLinks: links }).externalLinks).toEqual(expected);
		expect(UpdateProjectBaseSchema.parse({ externalLinks: links }).externalLinks).toEqual(expected);
		expect(ProjectChangeValuesSchema.parse({ externalLinks: links }).externalLinks).toEqual(expected);
		expect(UpdateProjectBaseSchema.parse({ externalLinks: [] }).externalLinks).toEqual([]);
		expect(UpdateProjectBaseSchema.parse({}).externalLinks).toBeUndefined();
	});
	it.each([
		[{ label: '', url: 'https://example.test' }],
		[{ label: ' '.repeat(3), url: 'https://example.test' }],
		[{ label: 'a'.repeat(81), url: 'https://example.test' }],
		[{ label: 'Game', url: 'javascript:alert(1)' }],
		[{ label: 'Game', url: 'data:text/html,test' }],
		[{ label: 'Game', url: 'ftp://example.test' }],
		[{ label: 'Game', url: 'example.test' }],
		[{ label: 'Game', url: 'https://example.test/' + 'a'.repeat(2000) }],
		Array.from({ length: 21 }, () => ({ label: 'Game', url: 'https://example.test' })),
	].map((invalid) => [invalid]))('rejects malformed or oversized links %#', (invalid) => {
		expect(ExternalLinksSchema.safeParse(invalid).success).toBe(false);
	});
});

describe('external link service detection', () => {
	it.each([
		['https://YouTube.com/watch?v=1', 'youtube'], ['https://youtu.be/abc', 'youtube'],
		['https://www.youtube-nocookie.com/embed/a', 'youtube'], ['https://drive.google.com/file/d/a', 'google-drive'],
		['https://docs.google.com/document/d/a', 'google-drive'], ['https://gist.github.com/user/id', 'github'],
		['https://github.com./user/repo', 'github'], ['https://creator.itch.io/game', 'itch-io'],
		['https://s.team/a', 'steam'], ['https://store.steampowered.com/app/1', 'steam'],
		['https://workspace.notion.site/page', 'notion'], ['https://notion.so/page', 'notion'],
		['https://www.notion.com/page', 'notion'], ['https://app.notion.com/p/demo', 'notion'],
		['https://discord.gg/invite', 'discord'], ['https://discordapp.com/channels/1', 'discord'],
	])('recognizes official host %s', (url, service) => {
		expect(detectExternalLinkService(url)).toBe(service);
	});
	it.each([
		'https://youtube.com.example.org', 'https://notyoutube.com', 'https://github.com@evil.org',
		'https://evil.github.com', 'https://itch.io.evil.org', 'https://foo.notion.site.evil.org',
		'https://foo.bar.itch.io', 'https://discord.gg.evil.org', 'https://github.io',
		'http://127.0.0.1', 'https://github.com:444/a', 'https://user:pass@youtube.com',
		'javascript:alert(1)', 'ftp://youtube.com', 'youtube.com', 'https://bit.ly/demo', 'https://steam.pm/demo',
	])('does not recognize deceptive or unsupported address %s', (url) => {
		expect(detectExternalLinkService(url)).toBeNull();
	});
	it('round trips optional service metadata without changing names or URLs', () => {
		const link = { label: '시연 영상', url: 'https://bit.ly/Original?Q=Yes#part', service: 'youtube' };
		expect(ExternalLinksSchema.parse([link])).toEqual([link]);
		expect(ExternalLinksSchema.safeParse([{ ...link, service: 'untrusted-service' }]).success).toBe(false);
	});
});
