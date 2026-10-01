export type GraphicsAccelerationStatus =
	| 'available'
	| 'software'
	| 'performance-caveat'
	| 'unavailable'
	| 'unknown';

type ContextVersion = 'webgl2' | 'webgl';
type ProbeResult = {
	supported: boolean;
	failed: boolean;
	renderer: string | null;
};

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render driver/i;

function probeContext(version: ContextVersion, strict: boolean): ProbeResult {
	let context: WebGLRenderingContext | WebGL2RenderingContext | null = null;
	try {
		// Context attributes are fixed on first creation, so every probe needs its own canvas.
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		context = canvas.getContext(version, { failIfMajorPerformanceCaveat: strict }) as
			| WebGLRenderingContext
			| WebGL2RenderingContext
			| null;
		if (!context) return { supported: false, failed: false, renderer: null };
		if (context.isContextLost()) return { supported: false, failed: true, renderer: null };

		// Renderer details may be withheld by privacy settings. That is inconclusive,
		// not evidence that hardware acceleration is disabled.
		let renderer: string | null = null;
		if (!strict) {
			const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
			if (debugInfo) {
				const value: unknown = context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
				if (typeof value === 'string' && value.trim()) renderer = value;
			}
		}
		return { supported: true, failed: false, renderer };
	} catch {
		return { supported: context !== null, failed: true, renderer: null };
	} finally {
		// Release GPU resources even if reading the renderer or creating another probe fails.
		try {
			context?.getExtension('WEBGL_lose_context')?.loseContext();
		} catch {
			// Cleanup is best effort and must not turn a usable probe into an error.
		}
	}
}

/** A local hint about WebGL acceleration, not a browser-setting or GPU guarantee. */
export function detectGraphicsAcceleration(): GraphicsAccelerationStatus {
	if (typeof document === 'undefined') return 'unknown';

	let failed = false;
	for (const version of ['webgl2', 'webgl'] as const) {
		const normal = probeContext(version, false);
		failed ||= normal.failed;
		if (!normal.supported) continue;
		if (normal.renderer && SOFTWARE_RENDERER.test(normal.renderer)) return 'software';

		const strict = probeContext(version, true);
		if (strict.failed) return 'unknown';
		if (!strict.supported) return 'performance-caveat';
		return normal.renderer && !normal.failed ? 'available' : 'unknown';
	}
	return failed ? 'unknown' : 'unavailable';
}
