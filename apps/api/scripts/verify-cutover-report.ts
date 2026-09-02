import { readFile } from 'node:fs/promises';

type Blocker = { count?: unknown; samples?: unknown };
type Report = {
	clean?: unknown;
	metricObservationReset?: unknown;
	blockers?: Record<string, Blocker>;
};

async function main(): Promise<void> {
	const [mode, path] = process.argv.slice(2);
	if (mode !== 'observation-start' || !path) {
		throw new Error('usage: verify-cutover-report observation-start /release-state/report.json');
	}
	const report = JSON.parse(await readFile(path, 'utf8')) as Report;
	if (!report.blockers || report.metricObservationReset !== true || report.clean !== false) {
		throw new Error('reconciliation report does not record a fresh observation reset');
	}
	const unexpected = Object.entries(report.blockers).filter(([name, blocker]) => (
		name !== 'legacyBridgeObservations' && blocker.count !== 0
	));
	const observation = report.blockers['legacyBridgeObservations'];
	if (unexpected.length > 0) {
		throw new Error(`reconciliation has non-observation blockers: ${unexpected.map(([name, blocker]) => `${name}=${blocker.count}`).join(', ')}`);
	}
	if (!observation || typeof observation.count !== 'number' || observation.count < 1) {
		throw new Error('fresh 24-hour legacy fallback observation is not the sole blocker');
	}
	console.log(JSON.stringify({ event: 'phase1_reconciliation_verified', observationBlockers: observation.count }));
}

void main().catch((error) => {
	console.error(JSON.stringify({ event: 'cutover_report_verification_failed', message: error instanceof Error ? error.message : String(error) }));
	process.exitCode = 1;
});
