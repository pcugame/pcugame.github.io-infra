import { createHash } from 'node:crypto';

const compatibilityRules = new Set([
	'no-api-processing-import',
	'no-api-object-body-read',
	'no-api-object-body-write',
	'no-api-uploadpart-relay',
]);

export const nodeDigest = (text) => createHash('sha256').update(text).digest('hex');
export const isPhase1RuntimeMarker = (source) => source?.trim() === "#!/usr/bin/env node\n\nconsole.log('PCU_PHASE1_RUNTIME_V1');";
const key = ({ rule, file, nodeSha256 }) => JSON.stringify([rule, file, nodeSha256]);

/** Reviewed Phase 1 source edges only; new, duplicated, and changed edges fail. */
export function applyPhase1Boundary(violations, { phase1, edges }) {
	if (!phase1) return { violations, compatibility: [] };
	const remaining = new Map();
	for (const edge of edges) {
		if (!compatibilityRules.has(edge.rule) || !Number.isInteger(edge.count) || edge.count < 1) {
			throw new Error(`Invalid Phase 1 architecture boundary: ${key(edge)}`);
		}
		if (remaining.has(key(edge))) throw new Error(`Duplicate Phase 1 architecture boundary: ${key(edge)}`);
		remaining.set(key(edge), { ...edge, left: edge.count });
	}
	const rejected = [];
	const compatibility = [];
	for (const violation of violations) {
		const edge = remaining.get(key({ ...violation, nodeSha256: nodeDigest(violation.nodeText) }));
		if (edge?.left > 0) {
			edge.left--;
			compatibility.push(violation);
		} else rejected.push(violation);
	}
	for (const edge of remaining.values()) {
		if (edge.left > 0) rejected.push({
			rule: 'stale-phase1-architecture-boundary', file: edge.file, line: 1, column: 1,
			message: `Retire or review the changed Phase 1 edge ${edge.nodeSha256}; remaining=${edge.left}`,
		});
	}
	return { violations: rejected, compatibility };
}
