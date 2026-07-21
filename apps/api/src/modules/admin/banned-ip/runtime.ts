import { protectedDownloadLimiter } from '../../../shared/protected-download-limiter.js';
import { prisma } from '../../../lib/prisma.js';
import { createBannedIpRepository } from './repository.js';
import { createBannedIpService } from './service.js';

export const bannedIpService = createBannedIpService({
	repository: createBannedIpRepository(prisma),
	banCache: {
		remove: (ip) => protectedDownloadLimiter.removeBan(ip),
	},
});
