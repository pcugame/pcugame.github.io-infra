import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Exercise the deployed test API, Garage multipart path, image worker and gateway. */
export async function runVotingSmoke({
	apiBase,
	origin,
	cookie,
	fetchJson,
	uploadAndComplete,
	requestPresignedObject,
	internalPublicAssetBase,
}) {
	const adminHeaders = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
	async function admin(path, body, method = 'POST') {
		return (
			await fetchJson(`${apiBase}/api/admin/${path}`, {
				method,
				headers: adminHeaders,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
		).body.data;
	}
	const exhibitions = await admin('exhibitions', undefined, 'GET');
	const exhibition = exhibitions.items.find((e) => e.visibility === 'PUBLIC');
	assert.ok(exhibition);
	const draw = await admin('draw-events', {
		version: 0,
		reason: 'Integration fixture',
		settings: {
			title: 'Integration voting draw',
			mode: 'FINITE',
			paused: false,
			items: [{ title: 'Integration prize', prize: true, remaining: 1, weight: 1, active: true }],
		},
	});
	let vote = await admin('votes', {
		exhibitionId: exhibition.id,
		title: 'Integration vote',
		guidance: '최대 {최대선택수}개',
		maxSelections: 1,
		state: 'OPEN',
		startsAt: null,
		endsAt: null,
		eventId: draw.id,
	});
	const bytes = await readFile(new URL('../apps/web/public/mock/images/400x560.png', import.meta.url));
	const blockSize = 1048576,
		digests = [];
	for (let offset = 0; offset < bytes.length; offset += blockSize)
		digests.push(
			createHash('sha256')
				.update(bytes.subarray(offset, offset + blockSize))
				.digest(),
		);
	const header = Buffer.alloc(16);
	header.writeBigUInt64BE(BigInt(bytes.length));
	header.writeUInt32BE(blockSize, 8);
	header.writeUInt32BE(digests.length, 12);
	const sourceIdentity = createHash('sha256')
		.update(Buffer.from('PCU-UPLOAD-SOURCE-V1\0'))
		.update(header)
		.update(Buffer.concat(digests))
		.digest('hex');
	const upload = await admin(`exhibitions/${exhibition.id}/direct-poster-upload-sessions`, {
		voteId: vote.id,
		originalName: 'voting.png',
		totalBytes: bytes.length,
		declaredMimeType: 'image/png',
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity,
		sourceIdentityBlockSizeBytes: blockSize,
		sourceIdentityBlockDigests: digests.map((d) => d.toString('hex')),
	});
	await uploadAndComplete(upload, bytes);
	const posters = await admin(`votes/${vote.id}/posters`, undefined, 'GET');
	assert.ok(posters.some((p) => p.id === upload.sessionId));
	vote = await admin(`votes/${vote.id}/candidates`, {
		title: 'Standalone candidate',
		posterId: upload.sessionId,
		active: true,
		version: vote.version,
		reason: 'Integration image worker',
		sourceProjectId: null,
	});
	const unchanged = (await admin('exhibitions', undefined, 'GET')).items.find((e) => e.id === exhibition.id);
	assert.deepEqual(unchanged.poster, exhibition.poster);
	const image = await requestPresignedObject(vote.candidates[0].posterUrl, {
		internalBase: internalPublicAssetBase,
	});
	assert.equal(image.status, 200);
	assert.ok(image.body.length > 0);
	const participantHeaders = { Origin: origin, 'X-Vote-Participant': randomBytes(32).toString('hex') };
	async function participant(action = '', body, method = 'POST') {
		return (
			await fetchJson(`${apiBase}/api/votes/${vote.id}${action ? '/' + action : ''}`, {
				method,
				headers: {
					...participantHeaders,
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
		).body.data;
	}
	const ballots = await Promise.all(
		Array.from({ length: 6 }, () =>
			participant('ballots', { version: vote.version, candidateIds: [vote.candidates[0].id] }),
		),
	);
	assert.equal(new Set(ballots.map((b) => b.id)).size, 1);
	const results = await Promise.all(Array.from({ length: 4 }, () => participant('draw')));
	assert.equal(new Set(results.map((d) => d.id)).size, 1);
	assert.equal(results[0].title, 'Integration prize');
	assert.ok(!/remaining|weight|calculation|participantHash/.test(JSON.stringify(results)));
	const receipts = await Promise.all(Array.from({ length: 4 }, () => participant('receive')));
	assert.equal(new Set(receipts.map((d) => d.receipt.id)).size, 1);
	vote = await admin(
		`votes/${vote.id}`,
		{ version: vote.version, settings: { ...vote.settings, state: 'CLOSED' }, reason: 'Integration close' },
		'PUT',
	);
	assert.equal(
		(await participant('ballots', { version: 1, candidateIds: [vote.candidates[0].id] })).id,
		ballots[0].id,
	);
	const records = await participant('records', undefined, 'GET');
	assert.equal(records.total, 1);
	assert.equal(records.totals[0].count, 1);
	assert.ok(!/ipHash|participantHash|browser|creator|actorId/.test(JSON.stringify(records)));
	await admin(
		`votes/${vote.id}`,
		{ version: vote.version, settings: { ...vote.settings, state: 'OPEN' }, reason: 'Integration reopen' },
		'PUT',
	);
	const hidden = await fetch(`${apiBase}/api/votes/${vote.id}/records`);
	assert.equal(hidden.status, 403);
	assert.equal(hidden.headers.get('cache-control'), 'private, no-store');
	console.log(
		'ok: voting poster multipart/image worker/gateway, immutable exhibition poster, concurrent ballot/draw/receipt, close/reopen',
	);
}
