import type { ExternalLinkService } from '@pcu/contracts';
import { api } from './client';

export const externalLinkApi = {
	resolve(url: string, signal?: AbortSignal) {
		return api.post<{ service: ExternalLinkService | null }>('/api/me/external-links/resolve', { url }, { signal });
	},
};
