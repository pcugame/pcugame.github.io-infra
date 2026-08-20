import type { AssetKind } from '@pcu/contracts';

/** Durable export-worker input. API control-plane modules may depend on this data shape only. */
export interface ExportProject {
	id: number;
	title: string;
	webglEntryKey: string;
	webglSourceKey?: string | null;
	exhibition: { year: number; title: string };
	members: { name: string; studentId: string; sortOrder: number }[];
	assets: {
		id: number;
		kind: AssetKind;
		storageKey: string;
		originalName: string;
		mimeType: string;
		sizeBytes: bigint;
	}[];
}
