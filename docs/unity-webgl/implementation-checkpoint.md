# Unity WebGL implementation checkpoint

Base: origin/master f4174cb. Original checkout preserved (local master 13 commits behind, clean).

- Ticket 1: feat/unity-fallback, /home/song/Desktop/pcugame-unity-fallback. Worker owns archive/content guidance and regression tests. Independent PR.
- Ticket 2: feat/webgl-play-sessions, /home/song/Desktop/pcugame-webgl-runtime. API worker owns persistence/session/auth hooks and HTTP tests. Gateway worker owns apps/db templates and gateway tests. Lead owns trusted shell, public webglPlayUrl contract/frontend, integration/review.
- Ticket 3: depends on ticket 2; separate branch/PR after foundation stabilizes. Exact-origin approval snapshot and revocation, no proxy.

Interfaces: permissionless GET /play/projects/:projectId; exact API-origin JSON POST create/renew/close with Fetch Metadata. Separate hashed control and asset secrets. NAS /runtime/<assetToken>/... uses existing internal gate; X-PCU-Runtime-CSP auth response. Live manifest/deployment/access/login checks for every file. 15m lease, visible 60s renew, max8h bounded login absolute expiry. Feature defaults off; general file token unchanged.

No user HTML on API. Shell hash CSP, initial frame source restricted to NAS /runtime/, narrowed by meta CSP to selected token directory before iframe creation; restart reloads shell. Gateway denies Service Worker registration, allows general Workers. Existing SW scope and actual browser isolation require verification.

Verification pending: real Unity five build variants + threaded/external fixture not found yet; user asked for paths asynchronously. Synthetic archives prove archive/delivery behavior only. Docker integration services exist; coordinate isolated DB tests. Playwright available in /tmp/pcu-browser-e2e; browser coverage pending.

Release remains PR -> CI verify/integration + review -> master -> immutable image -> Deploy Release -> web. No deployments performed.
