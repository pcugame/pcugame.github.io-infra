import { ConnectionRule, LabSourceSchema, type LabSource } from '@pcu/contracts';
import { z } from 'zod';
import { LabFailure, requestJson } from './http.js';

export interface SearchProvider {
	search(query: string, language: string, signal: AbortSignal): Promise<Omit<LabSource, 'id'>[]>;
}

const hitSchema = z.object({ title: z.string(), url: z.string(), content: z.string().optional() });
function publicLink(value: string) {
	const url = URL.parse(value);
	if (
		!url ||
		!['http:', 'https:'].includes(url.protocol) ||
		value.length > 2048 ||
		url.username ||
		url.password ||
		url.port
	)
		return false;
	try {
		ConnectionRule.parse(`https://${url.hostname}`);
		return true;
	} catch {
		return false;
	}
}

// The only network destination is the configured SearXNG instance. web_open
// resolves an opaque ID into the longer excerpt retained from that same search.
export function createSearchProvider(searchUrl?: string): SearchProvider {
	return {
		async search(query, language, signal) {
			if (!searchUrl) throw new LabFailure('SEARCH_NOT_CONFIGURED');
			const url = new URL(searchUrl + '/search');
			url.search = new URLSearchParams({
				q: query,
				language,
				format: 'json',
				categories: 'general',
			}).toString();
			const response = await requestJson(
				url,
				{ signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
				384_000,
			);
			const parsed = z.object({ results: z.array(z.unknown()) }).safeParse(response);
			if (!parsed.success) throw new LabFailure('SEARCH_INVALID_RESPONSE');
			const collectedAt = new Date().toISOString();
			const results = [];
			for (const item of parsed.data.results.slice(0, 20)) {
				const hit = hitSchema.safeParse(item);
				if (!hit.success || !publicLink(hit.data.url)) continue;
				const result = {
					title: hit.data.title.trim().slice(0, 400),
					snippet: (hit.data.content ?? '').slice(0, 1800),
					url: hit.data.url,
					collectedAt,
				};
				if (LabSourceSchema.safeParse({ id: 'S1', ...result }).success) results.push(result);
				if (results.length >= 4) break;
			}
			return results;
		},
	};
}
