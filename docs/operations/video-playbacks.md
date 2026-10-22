# Video playback versions

Uploaded originals retain their bytes and canonical `ORIGINAL` representation.
The native MP4 preserves decoded frame timestamps and frame count up to the
existing 120 fps input limit. Auxiliary profiles select every second/fourth
source frame without slowing playback. Every profile is generated from the
original, uploaded sequentially, and fully decoded and checked before activation.
Resolution selection adds a maximum-quality version (within the existing
1920×1080 box) and a 720p version for each FPS profile where it reduces resolution.
720p is the lowest selectable generated quality. Sources smaller than 720p keep
their existing dimensions without upscaling or duplicate outputs. An ultrawide
source keeps its aspect ratio within the 1920-pixel width limit.
No device detection, HLS, or automatic profile selection is introduced.

## Rollout

1. Apply additive migration `20261021000000_video_playback_versions` through the
   established release procedure, followed by additive migration
   `20261022000000_video_playback_qualities` before starting the new video worker.
   The second migration broadens the rendition key constraint to accept `@720p`
   without rewriting old rows or their object ownership. The first adds tables, indexes and constraints in one
   PostgreSQL transaction and leaves existing rows unchanged.
2. Replace API and video worker with the new revision. Keep
   `VIDEO_PLAYBACK_RENDITIONS_ENABLED=false` until both are replaced. New API
   queries require the migration even while generation is disabled. Retire all
   old video workers before enabling the queue.
3. Set `VIDEO_PLAYBACK_RENDITIONS_ENABLED=true` in the video worker environment
   (the optional shared `runtime-env/common.env` key for Quadlet deployments).
   Completed new uploads enqueue a playback job. Administrator retries enqueue
   the same queue, including videos without upload sessions. Maintain one video
   worker replica for batch concurrency of one. Each pass processes one upload
   and one playback job sequentially.
4. Audit preserved originals and current playback objects, review the JSONL
   report, then enqueue the reviewed inventory as described below.

These are release instructions, not evidence that a deployment or restoration
has occurred. Follow the deployment runbook, including forward recovery after a
migration attempt; do not automatically restore an older binary after migration.

## Inventory and resumable restoration

Run these commands in the worker environment with the release's DB/storage
configuration and FFmpeg installed. Commands do not alter or replace originals.
Use durable report storage outside the worker's temporary workspace.

```sh
# Read-only DB/object audit, sequential downloads and decoding; appends JSONL.
npm run video:playbacks -w apps/api -- audit /reports/video-originals.jsonl
# Review source checksum, fps/dimensions/duration, playback fps and profile plan.
# Enqueue only OK entries with matching original representation snapshots.
npm run video:playbacks -w apps/api -- enqueue /reports/video-originals.jsonl
```

Built release image equivalents:

```sh
node dist-release/scripts/video-playbacks.js audit /reports/video-originals.jsonl
node dist-release/scripts/video-playbacks.js enqueue /reports/video-originals.jsonl
```

Audit resumes by skipping successful entries in the same report. Use a new report
to refresh a previously successful inventory after source changes. Failed/missing
entries are rechecked on the next audit. Enqueue reports `QUEUED`,
`ALREADY_READY`, `PENDING_OR_CHANGED`, `SOURCE_CHANGED`, or `MISSING` per item.
It can be rerun: active jobs are deduplicated and an already active version with
the same source snapshot/checksum and the complete expected FPS/quality set is skipped.
Older FPS-only jobs are rebuilt when a 720p version is needed. Use a fresh audit
report for the new policy; reports without dimensions/expected renditions require
re-auditing (`AUDIT_REQUIRED`). Redirected/replaced source objects
are rechecked by checksum in the worker before activation, even when their size
is unchanged. Re-audit changed sources before enqueueing them again.

The worker persists job status/error in `video_playback_jobs`; the newest job is
returned in `playbackJob`. Failed jobs leave the last healthy playback active.
After correcting the cause, an administrator retry creates a fresh job. Expired
leases resume with a new attempt token/key; three interrupted attempts exhaust
the automatic recovery budget. Generated object ownership is recorded before
PUT, including failed and superseded attempts. A partial auxiliary upload never
activates a partial set.

## Delivery and cleanup

`url` and `variant=playback` continue to select the canonical native playback.
`playbacks[]` adds actual measured fps, dimensions and authenticated URLs for
`native`, `cap60`, and `cap30`. Optional `quality` is `max` (also the legacy
missing-field default) or `720p`. The playback download route accepts optional
`profile` and `quality` selectors; omitting both retains its canonical URL. Missing auxiliary profiles return 404; they do not silently select a
higher rate. Older videos without rendition rows retain their existing URLs.

The client uses the official `@videojs/react` 10.1.0 package (Apache-2.0), its
default skin source and Korean locale. The library owns playback controls,
keyboard interaction, seeking, speed, picture-in-picture and fullscreen. The
application adds MP4 frame-rate and resolution submenus under Settings using Video.js Menu
primitives, so it remains available in fullscreen. The source skin follows the
[official customization guide](https://videojs.org/docs/framework/react/guides/customize-skins);
see `apps/web/src/components/videojs/README.md` for update instructions.
Keep the version pinned and re-run browser checks when
upgrading. Official browser minima are Chrome/Edge 111, Firefox 121 and Safari/iOS
16.4; see [Video.js browser support](https://videojs.org/docs/framework/react/guides/browser-support).

The player defaults to native FPS and maximum quality. Both selections are explicit. User selection preserves playback position,
pause/play, volume, mute and playback speed; errors leave the selector and original download
available. Capability hydration/renewal recursively visits rendition URLs, and
the gateway rechecks current visibility and session access for every request,
including HEAD and Range.

Activation switches the compatibility `PLAYBACK` reference and all profiles in
one transaction. Previous generated files remain authorized for 24 hours, with
current project permissions rechecked. The worker then transfers their durable
cleanup ownership to the orphan outbox. Original keys are excluded from rollover
cleanup; explicit asset deletion continues to own original deletion. Rendition
and job rows survive hard asset/project deletion long enough to enqueue cleanup.
Disabling/stopping the video worker pauses this cleanup; it does not discard its
intent. Monitor pending cleanup and restore the worker to resume it.

## Verification

```sh
RUN_FFMPEG_TESTS=true npm exec -w apps/api -- vitest run src/__tests__/video-framerate.test.ts
RUN_POSTGRES_INTEGRATION=true RUN_FFMPEG_TESTS=true npm exec -w apps/api -- vitest run src/__tests__/video-playback.postgres.test.ts src/__tests__/project-video-upload.postgres.test.ts
# Vite on loopback; Playwright available to the script (or PLAYWRIGHT_MODULE_PATH).
npm exec -w apps/web -- vite --host 127.0.0.1 --port 5193
node scripts/video-player-browser.mjs
```

The integration runner includes `video-playbacks`; CI installs FFmpeg before
running it. Browser verification covers Chromium, Firefox and WebKit with actual
MP4 streams and user-selected profiles. It does not guarantee 120 fps decoding
performance on a particular low-end device. The gateway HTTP tests verify
profile authorization, method forwarding and Range acceptance; byte-level Range
serving remains the existing Nginx/Garage gateway's responsibility.

For a clickable, isolated local demo (synthetic media generated in a temporary
directory, no production configuration):

```sh
node scripts/video-player-preview.mjs
# Open http://127.0.0.1:5193/video-player-test
```

The demo requires local FFmpeg and binds only to loopback. Stop it with Ctrl+C;
its generated media are removed on shutdown.
