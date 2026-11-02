/** Content recognition is not a malware scan or a content moderation decision. */
export interface BuildInspection {
	version: 'build-package-v1';
	outcome: 'PASS' | 'REVIEW' | 'REJECT';
	engines: string[];
	evidence: string[];
	reasons: string[];
	entryCandidates: string[];
	entryPath: string | null;
	files: Array<{ path: string; bytes: number }>;
}
export interface BuildReviewApproval {
	sourceIdentity: string;
	generation: number;
	entryPath: string | null;
}
export class BuildReviewRequired extends Error {
	constructor(readonly inspection: BuildInspection) {
		super(inspection.reasons.join('; '));
	}
}
