import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.FIXTURE_ROOT ?? '/tmp/pcu-unity-fixture-repro', 'published'), port = 19011;
const repository = path.resolve(__dirname, '../..');
const runtimeRepository = process.env.RUNTIME_REPO_ROOT ?? repository;
const { renderPlayShell, playShellHeaders } = await import(pathToFileURL(path.join(runtimeRepository, 'apps/api/dist/modules/webgl-play/runtime-ui.js')).href);
const { runtimeCsp } = await import(pathToFileURL(path.join(runtimeRepository, 'apps/api/dist/modules/webgl-play/service.js')).href);
const apiOrigin = 'http://127.0.0.1:19012', assetOrigin = 'http://127.0.0.1:19011';
const config = { API_PUBLIC_URL: apiOrigin, WEB_PUBLIC_URL: apiOrigin, PUBLIC_ASSET_ORIGIN: assetOrigin };
const controlSecret = 'c'.repeat(64); // Synthetic local control only, never an authentication fixture.
const requestAudit = [];
const instrumentation = `<script>
window.__fixtureGlobals={onReady(){},drop(){},dragover(){},dragleave(){},onModelLoaded(success){__fixture.modelLoaded=Boolean(success)},updateStopWatch(){},registerViewer(){}};
window.__fixture={ready:false,started:false,workers:[],errors:[],isolated:crossOriginIsolated,sab:typeof SharedArrayBuffer==='function',parentBlocked:false};
try{parent.document.body}catch{__fixture.parentBlocked=true}
addEventListener('error',e=>__fixture.errors.push(String(e.message)));
addEventListener('securitypolicyviolation',e=>{__fixture.errors.push('CSP '+e.violatedDirective+' '+e.blockedURI);__fixture.blocked=true});
const OriginalWorker=window.Worker;
window.Worker=class extends OriginalWorker { constructor(...args){super(...args);const worker={url:String(args[0]),messages:[]};__fixture.workers.push(worker);this.addEventListener('message',e=>{if(e.data&&e.data.cmd)worker.messages.push(e.data.cmd)});}};
function wrapUnity(){if(typeof createUnityInstance!=='function'||createUnityInstance.__fixtureWrapped)return;const original=createUnityInstance;window.createUnityInstance=function(...args){__fixture.started=true;return original(...args).then(instance=>{window.__fixtureInstance=instance;__fixture.ready=true;return instance},error=>{__fixture.errors.push(String(error));throw error})};window.createUnityInstance.__fixtureWrapped=true;}
document.addEventListener('load',wrapUnity,true);
</script>`;
const nginxTemplate = fs.readFileSync(path.join(repository, 'apps/db/public-origin.nginx.conf.template'), 'utf8');
const csp = nginxTemplate.match(/add_header Content-Security-Policy "([^"\n]+)" always;/)[1].replace('${WEB_PUBLIC_ORIGIN}', 'http://127.0.0.1:19012');
const metadata = new Map();
for (const dir of fs.readdirSync(root))
    metadata.set(dir, new Map(JSON.parse(fs.readFileSync(path.join(root, dir, 'hosting-metadata.json'))).map(x => [x.key, x])));
const fixtureNames = [...metadata.keys()].sort();
const tokenFor = name => createHash('sha256').update(name).digest('hex');
const fixtureByToken = new Map(fixtureNames.map(name => [tokenFor(name), name]));
const apiServer = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, apiOrigin);
        const match = url.pathname.match(/^\/play\/projects\/(\d+)$/);
        if (match) {
            res.writeHead(200, { ...playShellHeaders(config), 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(renderPlayShell(config, Number(match[1])));
        }
        if (req.method === 'POST' && url.pathname.startsWith('/api/webgl-play/sessions')) {
            let text = '';
            for await (const part of req)
                text += part;
            const body = text ? JSON.parse(text) : {};
            const name = fixtureNames[(body.projectId ?? 1) - 1];
            let data;
            if (url.pathname.endsWith('/renew')) {
                data = { expiresAt: new Date(Date.now() + 900000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 28800000).toISOString() };
            }
            else if (url.pathname.endsWith('/close'))
                data = { closed: true };
            else {
                if (!name) {
                    res.writeHead(404);
                    return res.end();
                }
                data = { id: '11111111-1111-4111-8111-111111111111', controlSecret, iframeUrl: assetOrigin + '/runtime/' + tokenFor(name) + '/index.html', projectTitle: name, expiresAt: new Date(Date.now() + 900000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 28800000).toISOString() };
            }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ ok: true, data }));
        }
        if (url.pathname === '/fixture-list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(fixtureNames.map((name, index) => ({ name, projectId: index + 1, shellUrl: apiOrigin + '/play/projects/' + (index + 1) }))));
        }
        if (url.pathname === '/fixture-audit') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(requestAudit));
        }
        res.writeHead(404);
        res.end();
    }
    catch (error) {
        res.writeHead(500);
        res.end(String(error));
    }
}).listen(19012, '127.0.0.1', () => console.log('Synthetic-control trusted shell ' + apiOrigin));
const server = http.createServer((req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1:' + port);
        const parts = decodeURIComponent(url.pathname).slice(1).split('/');
        let fixture = parts.shift();
        let token;
        if (fixture === 'runtime') {
            token = parts.shift();
            fixture = fixtureByToken.get(token);
        }
        const key = parts.join('/');
        const policy = token ? runtimeCsp(assetOrigin, token, apiOrigin) : csp;
        requestAudit.push({ fixture, key, cookie: !!req.headers.cookie, hadControl: !!req.headers['x-pcu-play-control'] });
        const info = metadata.get(fixture)?.get(key);
        if (!info) {
            res.writeHead(404);
            return res.end('Missing fixture object');
        }
        ;
        const filename = path.resolve(root, fixture, key);
        if (!filename.startsWith(path.join(root, fixture) + '/')) {
            res.writeHead(400);
            return res.end();
        }
        ;
        let bytes = fs.readFileSync(filename);
        if (key === 'index.html') {
            let html = bytes.toString();
            if (fixture.startsWith('threaded-gltf')) {
                html = html.replaceAll('parent.globals', 'window.__fixtureGlobals').replace('src="../mwu.svg"', 'src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E"');
            }
            html = html.replace(/<head>/i, '<head>' + instrumentation);
            bytes = Buffer.from(html);
            res.setHeader('Content-Security-Policy', policy);
        }
        res.setHeader('Content-Security-Policy', policy);
        res.setHeader('Content-Type', info.contentType);
        if (info.contentEncoding)
            res.setHeader('Content-Encoding', info.contentEncoding);
        res.setHeader('Content-Length', bytes.length);
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(200);
        if (req.method === 'HEAD')
            res.end();
        else
            res.end(bytes);
    }
    catch (e) {
        res.writeHead(500);
        res.end(String(e));
    }
}).listen(port, '127.0.0.1', () => console.log('local fixture server http://127.0.0.1:' + port));
process.on('SIGTERM', () => { server.close(); apiServer.close(); });
