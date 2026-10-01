import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectGraphicsAcceleration } from '../lib/graphicsAcceleration';

function fakeContext(renderer: unknown = 'ANGLE (Intel, Intel Iris Xe Graphics)') {
	const loseContext = vi.fn();
	const getParameter = vi.fn(() => renderer);
	const getExtension = vi.fn((name: string) => {
		if (name === 'WEBGL_lose_context') return { loseContext };
		if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 };
		return null;
	});
	return { getExtension, getParameter, loseContext, isContextLost: vi.fn(() => false) };
}

type FakeContext = ReturnType<typeof fakeContext>;
type ContextResponse = FakeContext | null | Error;

function fakeDocument(...responses: ContextResponse[]) {
	const canvases: { getContext: ReturnType<typeof vi.fn> }[] = [];
	const createElement = vi.fn(() => {
		const response = responses[canvases.length];
		const canvas = {
			getContext: vi.fn(() => {
				if (response instanceof Error) throw response;
				if (response === undefined) throw new Error('Unexpected context request');
				return response;
			}),
		};
		canvases.push(canvas);
		return canvas;
	});
	vi.stubGlobal('document', { createElement });
	return { canvases, createElement };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('detectGraphicsAcceleration', () => {
	it('compares normal and strict contexts on different canvases and releases both', () => {
		const normal = fakeContext();
		const strict = fakeContext();
		const { canvases, createElement } = fakeDocument(normal, strict);

		expect(detectGraphicsAcceleration()).toBe('available');
		expect(createElement).toHaveBeenCalledTimes(2);
		expect(createElement).toHaveBeenCalledWith('canvas');
		expect(canvases[0]).not.toBe(canvases[1]);
		expect(canvases[0].getContext).toHaveBeenCalledExactlyOnceWith('webgl2', { failIfMajorPerformanceCaveat: false });
		expect(canvases[1].getContext).toHaveBeenCalledExactlyOnceWith('webgl2', { failIfMajorPerformanceCaveat: true });
		expect(normal.loseContext).toHaveBeenCalledOnce();
		expect(strict.loseContext).toHaveBeenCalledOnce();
	});

	it('falls back to WebGL1 and compares strict support of that same version', () => {
		const normal = fakeContext();
		const strict = fakeContext();
		const { canvases } = fakeDocument(null, normal, strict);

		expect(detectGraphicsAcceleration()).toBe('available');
		expect(canvases[1].getContext).toHaveBeenCalledExactlyOnceWith('webgl', { failIfMajorPerformanceCaveat: false });
		expect(canvases[2].getContext).toHaveBeenCalledExactlyOnceWith('webgl', { failIfMajorPerformanceCaveat: true });
		expect(normal.loseContext).toHaveBeenCalledOnce();
		expect(strict.loseContext).toHaveBeenCalledOnce();
	});

	it.each([
		'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))',
		'llvmpipe (LLVM 15.0.7, 256 bits)',
		'softpipe',
		'Software Rasterizer',
		'Microsoft Basic Render Driver',
	])('recognizes explicit software rendering: %s', (renderer) => {
		const normal = fakeContext(renderer);
		fakeDocument(normal);
		expect(detectGraphicsAcceleration()).toBe('software');
		expect(normal.loseContext).toHaveBeenCalledOnce();
	});

	it('reports a performance caveat only when normal support exists but strict creation fails', () => {
		const normal = fakeContext();
		fakeDocument(normal, null);
		expect(detectGraphicsAcceleration()).toBe('performance-caveat');
		expect(normal.loseContext).toHaveBeenCalledOnce();
	});

	it('reports unavailable when both normal context versions return null', () => {
		const { canvases } = fakeDocument(null, null);
		expect(detectGraphicsAcceleration()).toBe('unavailable');
		expect(canvases).toHaveLength(2);
	});

	it('treats a privacy-hidden debug extension as unknown and cleans up', () => {
		const normal = fakeContext();
		normal.getExtension.mockImplementation((name) => name === 'WEBGL_lose_context' ? { loseContext: normal.loseContext } : null);
		const strict = fakeContext();
		fakeDocument(normal, strict);
		expect(detectGraphicsAcceleration()).toBe('unknown');
		expect(normal.getParameter).not.toHaveBeenCalled();
		expect(normal.loseContext).toHaveBeenCalledOnce();
		expect(strict.loseContext).toHaveBeenCalledOnce();
	});

	it.each([null, '', 123])('treats a missing or invalid renderer (%s) as unknown', (renderer) => {
		fakeDocument(fakeContext(renderer), fakeContext());
		expect(detectGraphicsAcceleration()).toBe('unknown');
	});

	it('can detect a strict performance caveat even if renderer details are hidden', () => {
		fakeDocument(fakeContext(null), null);
		expect(detectGraphicsAcceleration()).toBe('performance-caveat');
	});

	it('distinguishes context creation exceptions from unsupported WebGL', () => {
		fakeDocument(new Error('Probe blocked'), null);
		expect(detectGraphicsAcceleration()).toBe('unknown');
	});

	it('uses positive WebGL1 evidence after a WebGL2 exception', () => {
		fakeDocument(new Error('WebGL2 blocked'), fakeContext(), fakeContext());
		expect(detectGraphicsAcceleration()).toBe('available');
	});

	it('does not mislabel a strict creation exception as a performance caveat', () => {
		const normal = fakeContext();
		fakeDocument(normal, new Error('Strict probe blocked'));
		expect(detectGraphicsAcceleration()).toBe('unknown');
		expect(normal.loseContext).toHaveBeenCalledOnce();
	});

	it('releases contexts even when reading renderer information throws', () => {
		const normal = fakeContext();
		normal.getParameter.mockImplementation(() => { throw new Error('Renderer blocked'); });
		const strict = fakeContext();
		fakeDocument(normal, strict);
		expect(detectGraphicsAcceleration()).toBe('unknown');
		expect(normal.loseContext).toHaveBeenCalledOnce();
		expect(strict.loseContext).toHaveBeenCalledOnce();
	});

	it('treats lost contexts as inconclusive and still attempts cleanup', () => {
		const normal = fakeContext();
		normal.isContextLost.mockReturnValue(true);
		fakeDocument(normal, null);
		expect(detectGraphicsAcceleration()).toBe('unknown');
		expect(normal.loseContext).toHaveBeenCalledOnce();
	});

	it('keeps a result usable if cleanup throws and still releases the other context', () => {
		const normal = fakeContext();
		normal.loseContext.mockImplementation(() => { throw new Error('Cleanup failed'); });
		const strict = fakeContext();
		fakeDocument(normal, strict);
		expect(detectGraphicsAcceleration()).toBe('available');
		expect(strict.loseContext).toHaveBeenCalledOnce();
	});

	it('preserves the result when the cleanup extension is absent or throws', () => {
		const normal = fakeContext();
		normal.getExtension.mockImplementation((name) => {
			if (name === 'WEBGL_lose_context') throw new Error('Cleanup extension blocked');
			return { UNMASKED_RENDERER_WEBGL: 0x9246 };
		});
		const strict = fakeContext();
		strict.getExtension.mockReturnValue(null);
		fakeDocument(normal, strict);
		expect(detectGraphicsAcceleration()).toBe('available');
		expect(strict.getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
	});

	it('treats a lost strict context as unknown and releases both contexts', () => {
		const normal = fakeContext();
		const strict = fakeContext();
		strict.isContextLost.mockReturnValue(true);
		fakeDocument(normal, strict);
		expect(detectGraphicsAcceleration()).toBe('unknown');
		expect(normal.loseContext).toHaveBeenCalledOnce();
		expect(strict.loseContext).toHaveBeenCalledOnce();
	});

	it('returns unknown without a browser document', () => {
		vi.stubGlobal('document', undefined);
		expect(detectGraphicsAcceleration()).toBe('unknown');
	});

	it('returns unknown if canvas creation throws', () => {
		vi.stubGlobal('document', { createElement: () => { throw new Error('Canvas blocked'); } });
		expect(detectGraphicsAcceleration()).toBe('unknown');
	});
});
