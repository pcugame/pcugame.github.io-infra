/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: 'no-circular',
			severity: 'error',
			from: { path: '^src' },
			to: { circular: true },
		},
		{
			name: 'controllers-do-not-use-repositories',
			severity: 'error',
			from: { path: 'controller\\.ts$' },
			to: { path: '(repository|lib/prisma)\\.ts$' },
		},
		{
			name: 'application-services-do-not-use-fastify',
			severity: 'error',
			from: { path: '(service|serializer|state-machine)\\.ts$' },
			to: { path: '^fastify$' },
		},
		{
			name: 'application-services-do-not-use-infrastructure',
			severity: 'error',
			from: { path: '(service|serializer|state-machine)\\.ts$' },
			to: {
				path: '(config/env|lib/(prisma|s3|storage)|object-deletion|repository)\\.ts$|\\.(runtime|adapter)\\.ts$',
			},
		},
		{
			name: 'application-ports-do-not-use-infrastructure',
			severity: 'error',
			from: { path: '^src/application/' },
			to: { path: '^src/(config|generated|infrastructure|lib|modules/.+/(runtime|repository))' },
		},
	],
	options: {
		doNotFollow: { path: '(^|/)node_modules/' },
		exclude: { path: '(^|/)(dist|generated|__tests__)/' },
		tsConfig: { fileName: 'tsconfig.json' },
		enhancedResolveOptions: { exportsFields: ['exports'] },
		reporterOptions: {
			dot: { collapsePattern: 'node_modules/[^/]+' },
		},
	},
};
