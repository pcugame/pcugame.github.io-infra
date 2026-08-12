#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const migrationRoot = 'apps/api/prisma/migrations';
const migrationPathPattern = /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/;

// The protected base is a conservative review proxy, not proof that every file
// in it was applied to every preserved database. Operators still need to inspect
// real Prisma/PostgreSQL migration history when application state is uncertain.
const baseHistoryNotice =
	'Protected-base history is a review safety proxy; repository publication alone does not prove a migration was applied.';

function annotationValue(value) {
	return value
		.replaceAll('%', '%25')
		.replaceAll('\r', '%0D')
		.replaceAll('\n', '%0A');
}

function markdownValue(value) {
	return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('<', '&lt;');
}

function runGit(args, { allowFailure = false } = {}) {
	const result = spawnSync('git', args, {
		encoding: args.includes('-z') ? 'buffer' : 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.error) throw result.error;
	if (result.status !== 0 && !allowFailure) {
		const stderr = Buffer.isBuffer(result.stderr)
			? result.stderr.toString('utf8')
			: result.stderr;
		throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
	}
	return result;
}

function gitText(args) {
	const result = runGit(args);
	return String(result.stdout).trim();
}

function nulFields(buffer) {
	const fields = buffer.toString('utf8').split('\0');
	if (fields.at(-1) === '') fields.pop();
	return fields;
}

function changedEntries(mergeBase) {
	const fields = nulFields(runGit([
		'diff',
		'--name-status',
		'-z',
		'--find-renames',
		'--find-copies-harder',
		mergeBase,
		'HEAD',
		'--',
		migrationRoot,
	]).stdout);
	const entries = [];
	for (let index = 0; index < fields.length;) {
		const status = fields[index++];
		if (!status) throw new Error('git diff returned an empty status field');
		if (/^[RC]/.test(status)) {
			const oldPath = fields[index++];
			const path = fields[index++];
			if (!oldPath || !path) throw new Error(`git diff returned an incomplete ${status} record`);
			entries.push({ status, oldPath, path });
		} else {
			const path = fields[index++];
			if (!path) throw new Error(`git diff returned an incomplete ${status} record`);
			entries.push({ status, path });
		}
	}
	return entries;
}

function baseMigrationPaths(mergeBase) {
	return new Set(
		nulFields(runGit([
			'ls-tree',
			'-r',
			'--name-only',
			'-z',
			mergeBase,
			'--',
			migrationRoot,
		]).stdout).filter((path) => migrationPathPattern.test(path)),
	);
}

function showHeadFile(path) {
	return String(runGit(['show', `HEAD:${path}`]).stdout);
}

function lineAt(source, offset) {
	return source.slice(0, offset).split('\n').length;
}

const riskPatterns = [
	{
		kind: 'destructive schema operation',
		pattern: /\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/gi,
	},
	{
		kind: 'legacy-row constraint strengthening',
		pattern: /\bALTER\s+TABLE\b[^;]*?\bADD\s+CONSTRAINT\b|\bALTER\s+COLUMN\b[^;]*?\bSET\s+NOT\s+NULL\b|\bCREATE\s+UNIQUE\s+INDEX\b/gi,
	},
	{
		kind: 'identity/key semantics change',
		pattern: /\bALTER\s+COLUMN\b[^;]*?\bTYPE\b|\b(?:ADD|DROP)\s+(?:GENERATED|IDENTITY|PRIMARY\s+KEY)\b|\bREPLICA\s+IDENTITY\b|\bDROP\s+CONSTRAINT\b[^;\n]*\b(?:pkey|key)\b/gi,
	},
];

function riskSignals(path) {
	const sql = showHeadFile(path);
	const signals = [];
	for (const { kind, pattern } of riskPatterns) {
		pattern.lastIndex = 0;
		const match = pattern.exec(sql);
		if (match) signals.push({ path, line: lineAt(sql, match.index), kind });
	}
	return signals;
}

function reportAnnotation(level, path, message, line) {
	if (process.env['GITHUB_ACTIONS'] !== 'true') return;
	const location = line ? `,line=${line}` : '';
	console.log(`::${level} file=${annotationValue(path)}${location}::${annotationValue(message)}`);
}

function writeSummary({ baseRef, mergeBase, violations, warnings, newMigrations }) {
	const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
	if (!summaryPath) return;
	const result = violations.length > 0 ? 'FAIL' : warnings.length > 0 ? 'PASS with review warnings' : 'PASS';
	const lines = [
		'## Migration policy guard',
		'',
		`- Result: **${result}**`,
		`- Base: \`${markdownValue(baseRef)}\` (merge base \`${mergeBase}\`)`,
		`- New canonical migrations: ${newMigrations.length}`,
		`- Protected-history violations: ${violations.length}`,
		`- High-risk review signals: ${warnings.length}`,
		`- Scope note: ${baseHistoryNotice}`,
	];
	if (violations.length > 0) {
		lines.push('', '### Protected-history violations', '');
		for (const violation of violations) {
			lines.push(`- \`${markdownValue(violation.path)}\`: ${markdownValue(violation.message)}`);
		}
	}
	if (warnings.length > 0) {
		lines.push('', '### Reviewer attention (heuristic only)', '');
		for (const warning of warnings) {
			lines.push(`- \`${markdownValue(warning.path)}:${warning.line}\`: ${warning.kind}`);
		}
		lines.push('', 'These signals do not prove migration correctness or require a transaction.');
	}
	appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

function main() {
	const baseRef = process.argv[2];
	if (!baseRef || process.argv.length !== 3) {
		console.error('Usage: node scripts/check-migration-policy.mjs <base-ref>');
		return 2;
	}

	gitText(['rev-parse', '--show-toplevel']);
	const baseCommit = gitText(['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
	gitText(['rev-parse', '--verify', 'HEAD^{commit}']);
	const mergeBase = gitText(['merge-base', baseCommit, 'HEAD']);
	const protectedPaths = baseMigrationPaths(mergeBase);
	const entries = changedEntries(mergeBase);
	const violations = [];
	const newMigrations = new Set();

	for (const entry of entries) {
		const oldPath = entry.oldPath ?? entry.path;
		if (protectedPaths.has(oldPath)) {
			violations.push({
				path: oldPath,
				message: `status ${entry.status} changes migration history already present at the protected merge base`,
			});
			continue;
		}
		if (migrationPathPattern.test(entry.path) && !entry.status.startsWith('D')) {
			newMigrations.add(entry.path);
		}
	}

	const warnings = Array.from(newMigrations).sort().flatMap(riskSignals);
	console.log(`[migration-policy] ${baseHistoryNotice}`);
	for (const violation of violations) {
		const message = `${violation.message}; restore it and add a follow-up migration instead`;
		console.error(`[migration-policy] ERROR ${violation.path}: ${message}`);
		reportAnnotation('error', violation.path, message);
	}
	for (const warning of warnings) {
		const message = `${warning.kind} detected in a new migration; perform the required high-risk review and semantic tests`;
		console.warn(`[migration-policy] WARNING ${warning.path}:${warning.line}: ${message}`);
		reportAnnotation('warning', warning.path, message, warning.line);
	}
	if (warnings.length > 0) {
		console.log('[migration-policy] Heuristic warnings are reviewer prompts only; they do not prove correctness, atomicity, or rollback behavior.');
	}
	writeSummary({
		baseRef,
		mergeBase,
		violations,
		warnings,
		newMigrations: Array.from(newMigrations),
	});

	if (violations.length > 0) return 1;
	console.log(
		`[migration-policy] PASS protected-history=unchanged new-migrations=${newMigrations.size} review-signals=${warnings.length}`,
	);
	return 0;
}

try {
	process.exitCode = main();
} catch (error) {
	console.error(`[migration-policy] ERROR ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 2;
}
