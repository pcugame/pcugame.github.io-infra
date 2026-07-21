import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { generateSessionId } from '../../shared/session.js';
import { createGoogleTokenVerifier, systemClock } from '../../infrastructure/production-ports.js';
import * as repository from './repository.js';
import { createAuthService } from './service.js';

let productionService: ReturnType<typeof createAuthService> | undefined;

function service() {
	if (productionService) return productionService;
	const config = env();
	productionService = createAuthService({
		repository,
		googleTokens: createGoogleTokenVerifier(),
		clock: systemClock,
		generateSessionId,
		sessionAbsoluteMs: config.SESSION_ABSOLUTE_MS,
		googleClientIds: config.GOOGLE_CLIENT_IDS,
		allowedGoogleHostedDomain: config.ALLOWED_GOOGLE_HD,
		logger: {
			info: (context, message) => logger().info(context, message),
			warn: (context, message) => logger().warn(context, message),
			error: (context, message) => logger().error(context, message),
		},
	});
	return productionService;
}

export const authService = {
	loginWithGoogle: (...args: Parameters<ReturnType<typeof service>['loginWithGoogle']>) => (
		service().loginWithGoogle(...args)
	),
	loginForDevRole: (...args: Parameters<ReturnType<typeof service>['loginForDevRole']>) => (
		service().loginForDevRole(...args)
	),
	logout: (...args: Parameters<ReturnType<typeof service>['logout']>) => service().logout(...args),
};
