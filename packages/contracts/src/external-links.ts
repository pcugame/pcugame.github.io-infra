import { z } from 'zod';

export const ExternalLinkSchema = z.object({
	label: z.string().trim().min(1, '링크 이름을 입력하세요.').max(80, '링크 이름은 80자 이하여야 합니다.'),
	url: z.string().trim().max(2000, '주소는 2,000자 이하여야 합니다.').pipe(
		z.url({ protocol: /^https?$/, error: 'http 또는 https로 시작하는 올바른 주소를 입력하세요.' }),
	),
}).strict();

export const ExternalLinksSchema = z.array(ExternalLinkSchema).max(20, '외부 링크는 최대 20개까지 추가할 수 있습니다.');
export type ExternalLink = z.infer<typeof ExternalLinkSchema>;
