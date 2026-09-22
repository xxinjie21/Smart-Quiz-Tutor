import obsidianmd from 'eslint-plugin-obsidianmd';
import { parser as tsParser } from 'typescript-eslint';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'.workbuddy-ai',
		'.workbuddy-ai/**',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'tests',
		'vitest.config.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				Buffer: true,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	// Obsidian 官方的 manifest 校验默认**从不执行**：`obsidianmd/validate-manifest` 的
	// create() 第一句就是 `if (!basename(physicalFilename).endsWith("manifest.json")) return {}`
	// （见 node_modules/eslint-plugin-obsidianmd/dist/lib/rules/validateManifest.js:66），
	// 而 ESLint 扫描目录时不包含 .json 文件 —— 所以它挂在 ts 那层配置上等于空转，
	// 必须在这里显式声明 files，manifest.json 才会真正被校验。
	// 它检查：必填字段、字段类型、未知字段、重复键、name/description/id 里的禁用词
	// （obsidian / plugin），以及 description 的长度 10-250、首字母大写、句号结尾、仅 ASCII。
	{
		files: ['manifest.json'],
		languageOptions: {
			parser: tsParser,
		},
		plugins: { obsidianmd },
		rules: {
			'obsidianmd/validate-manifest': 'error',
		},
	},
);
