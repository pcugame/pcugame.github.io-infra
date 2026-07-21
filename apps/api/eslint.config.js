import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['dist/**', 'src/generated/**', 'coverage/**'],
	},
	{
		files: ['src/**/*.ts', 'prisma/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: { allowDefaultProject: ['prisma/*.ts'] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			'@typescript-eslint': tseslint.plugin,
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
			'@typescript-eslint/no-unnecessary-type-assertion': 'error',
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
		},
	},
	{
		files: ['src/__tests__/**/*.ts'],
		rules: {
			// Characterization fixtures intentionally model malformed/untyped Fastify input.
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unnecessary-type-assertion': 'off',
			'@typescript-eslint/consistent-type-imports': 'off',
		},
	},
);
