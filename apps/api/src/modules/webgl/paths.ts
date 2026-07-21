import { randomUUID } from 'node:crypto';

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

interface WebglDeploymentIdentity {
	projectId: number;
	deploymentId: string;
}

/** The protected recovery input. Deleting it makes restart recovery impossible. */
export interface WebglProtectedSourceKeys extends WebglDeploymentIdentity {
	sourceKey: string;
}

/** The replaceable public output. It is safe to roll this back before pointer commit. */
export interface WebglPublicDeploymentKeys extends WebglDeploymentIdentity {
	sitePrefix: string;
}

export interface WebglDeploymentKeys extends WebglProtectedSourceKeys, WebglPublicDeploymentKeys {
	deploymentPrefix: string;
	entryKey: string;
}

export function createWebglDeploymentKeys(
	projectId: number,
	deploymentId: string = randomUUID(),
): WebglDeploymentKeys {
	const deploymentPrefix = `webgl/${projectId}/${deploymentId}/`;
	const sitePrefix = `${deploymentPrefix}site/`;
	return {
		projectId,
		deploymentId,
		deploymentPrefix,
		sourceKey: `${deploymentPrefix}source.zip`,
		sitePrefix,
		entryKey: `${sitePrefix}index.html`,
	};
}

export function parseWebglEntryKey(projectId: number, entryKey: string): WebglDeploymentKeys | null {
	const match = new RegExp(`^webgl/${projectId}/(${UUID_RE})/site/index\\.html$`, 'i').exec(entryKey);
	return match?.[1] ? createWebglDeploymentKeys(projectId, match[1]) : null;
}

export function parseWebglSourceKey(projectId: number, sourceKey: string): WebglDeploymentKeys | null {
	const match = new RegExp(`^webgl/${projectId}/(${UUID_RE})/source\\.zip$`, 'i').exec(sourceKey);
	return match?.[1] ? createWebglDeploymentKeys(projectId, match[1]) : null;
}

export function webglUrl(apiPublicUrl: string, projectId: number): string {
	return `${apiPublicUrl.replace(/\/$/, '')}/api/public/webgl/${projectId}/`;
}
