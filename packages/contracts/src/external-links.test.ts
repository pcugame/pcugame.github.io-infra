import { describe, expect, it } from 'vitest';
import { ExternalLinksSchema, ProjectChangeValuesSchema, SubmitProjectPayloadBaseSchema, UpdateProjectBaseSchema } from './index.js';

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
