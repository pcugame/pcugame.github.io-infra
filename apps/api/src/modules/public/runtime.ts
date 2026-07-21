import { env } from '../../config/env.js';
import { getPresignedUrl } from '../../lib/storage.js';
import * as repository from './repository.js';
import { createPublicService } from './service.js';

function dependencies() {
	const config = env();
	return {
		apiPublicUrl: config.API_PUBLIC_URL,
		publicBucket: config.S3_BUCKET_PUBLIC,
		presign: getPresignedUrl,
		repository,
	};
}

let productionService: ReturnType<typeof createPublicService> | undefined;

function service() {
	productionService ??= createPublicService(dependencies());
	return productionService;
}

export const publicService: ReturnType<typeof createPublicService> = {
	listYears: () => service().listYears(),
	getExhibitionPosterRedirectUrl: (storageKey) => service().getExhibitionPosterRedirectUrl(storageKey),
	listProjectsByYear: (year) => service().listProjectsByYear(year),
	listProjectsByExhibition: (id) => service().listProjectsByExhibition(id),
	getProjectDetail: (idOrSlug, year) => service().getProjectDetail(idOrSlug, year),
};
