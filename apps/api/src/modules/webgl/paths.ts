const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

interface WebglDeploymentIdentity {
	projectId: number;
	deploymentId: string;
}

/** The protected recovery input. Deleting it makes restart recovery impossible. */
export interface WebglProtectedSourceKeys {
	projectId: number;
	sourceDeploymentId?: string;
	sourceKey: string;
}

/** The replaceable public output. It is safe to roll this back before pointer commit. */
export interface WebglPublicDeploymentKeys extends WebglDeploymentIdentity {
	deploymentPrefix: string;
	sitePrefix: string;
	entryKey: string;
}

export interface WebglDeploymentKeys extends WebglPublicDeploymentKeys {
	sourceDeploymentId?: string;
	sourceKey: string;
}

export function createWebglProtectedSourceKeys(
	projectId: number,
	sourceDeploymentId: string,
): WebglProtectedSourceKeys {
	return {
		projectId,
		sourceDeploymentId,
		sourceKey: `webgl/${projectId}/${sourceDeploymentId}/source.zip`,
	};
}

export function createWebglPublicDeploymentKeys(
	projectId: number,
	deploymentId: string,
): WebglPublicDeploymentKeys {
	const deploymentPrefix = `webgl/${projectId}/${deploymentId}/`;
	const sitePrefix = `${deploymentPrefix}site/`;
	return {
		projectId,
		deploymentId,
		deploymentPrefix,
		sitePrefix,
		entryKey: `${sitePrefix}index.html`,
	};
}

export function createWebglDeploymentKeys(
	projectId: number,
	deploymentId: string,
): WebglDeploymentKeys {
	return {
		...createWebglProtectedSourceKeys(projectId, deploymentId),
		...createWebglPublicDeploymentKeys(projectId, deploymentId),
	};
}

/** Bind a protected source generation to an independently opaque public generation. */
export function bindWebglDeploymentKeys(
	source: WebglProtectedSourceKeys,
	deploymentId: string,
): WebglDeploymentKeys {
	return {
		...source,
		...createWebglPublicDeploymentKeys(source.projectId, deploymentId),
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

/** Return the immutable deployment entry URL owned by the public object origin. */
export function webglUrl(publicAssetBaseUrl: string, entryKey: string): string {
	if (!new RegExp(`^webgl/[1-9]\\d*/${UUID_RE}/site/index\\.html$`, 'i').test(entryKey)) {
		throw new Error('Cannot serialize malformed WebGL entry key');
	}
	return `${publicAssetBaseUrl.replace(/\/$/, '')}/${entryKey
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/')}`;
}
