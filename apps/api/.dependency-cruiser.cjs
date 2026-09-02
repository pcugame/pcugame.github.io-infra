/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: 'no-circular',
			severity: 'error',
			from: { path: '^(?:src|architecture-fixtures)' },
			to: { circular: true },
		},
		{
			name: 'no-api-processing-import',
			severity: 'error',
			from: { path: '(?:app|server|backend-context|controller|service)\\.ts$' },
			to: {
				path: '(?:^node:child_process$|^sharp$|^pdf-to-img$|bounded-zip-validator|/modules/archive/|/modules/assets/upload/(?:file-validator|image-processing|pdf-processing|video-processing|zip-file-validation)|/modules/video/(?:command-runner|composition|ffmpeg-operations|materialize|processor|worker)|/modules/webgl/(?:deployment|processing)|/modules/admin/export/(?:file\\.adapter|nas-staging\\.adapter|worker))',
			},
		},
		{
			name: 'no-api-worker-import',
			severity: 'error',
			from: { path: '(?:app|server|backend-context|controller|service)\\.ts$' },
			to: { path: '(?:worker|validation-worker|processing\\.composition)\\.ts$' },
		},
		{
			name: 'no-feature-storage-sdk-import',
			severity: 'error',
			from: {
				path: '(?:^|/)src/modules/',
				pathNot: '(?:^|/)(?:composition|[^/]+\\.composition|[^/]*worker)\\.ts$',
			},
			to: { path: '@aws-sdk/(?:client-s3|s3-request-presigner)' },
		},
		{
			name: 'no-worker-api-import',
			severity: 'error',
			from: { path: '(?:^|/)[^/]*worker\\.ts$' },
			to: { path: '(?:^fastify$|/(?:app|server|backend-context|[^/]*controller)\\.ts$)' },
		},
	],
	options: {
		doNotFollow: { path: '(^|/)node_modules/' },
		exclude: { path: '(^|/)(dist|generated|__tests__)/' },
		tsConfig: { fileName: 'tsconfig.json' },
		enhancedResolveOptions: { exportsFields: ['exports'] },
		reporterOptions: { dot: { collapsePattern: 'node_modules/[^/]+' } },
	},
};
