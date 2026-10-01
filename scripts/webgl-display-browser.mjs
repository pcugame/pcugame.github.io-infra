#!/usr/bin/env node
// Repeatable browser probe of the compiled API shell, real CSP and mock session controls.
// Build apps/api first. Install Playwright separately or set PLAYWRIGHT_MODULE_PATH.
// Optional: PLAYWRIGHT_BROWSER=firefox BROWSER_EXECUTABLE=/path/to/firefox.
// This synthetic input/Worker fixture supplements, rather than replaces, actual Unity acceptance.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderPlayShell, playShellHeaders } from '../apps/api/dist/modules/webgl-play/runtime-ui.js';
import { runtimeCsp } from '../apps/api/dist/modules/webgl-play/service.js';
const require = createRequire(import.meta.url);
const playwright = process.env.PLAYWRIGHT_MODULE_PATH ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href) : require('playwright');
const engine = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const token = 'a'.repeat(64), otherToken = 'b'.repeat(64), controlSecret = 'c'.repeat(64);
const title = '<img src=x onerror="window.titleInjected=true"> & display fixture';
let dimensions = [1280,720], displayKind = 'fixed', config, apiOrigin, assetOrigin;
let creates = 0, loads = 0, renewals = 0, closes = 0, denyRenew = false, otherRequests = 0;
const assetRequests = [];
const baselineFaviconViolations = [];
const serve = handler => new Promise(resolve => { const server=http.createServer(handler);server.listen(0,'127.0.0.1',()=>resolve(server)); });
const origin = server => `http://127.0.0.1:${server.address().port}`;
const json = (res,status,data) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(status===200?{ok:true,data}:{ok:false,error:{code:'FORBIDDEN'}})); };
const api = await serve((req,res) => {
 if(req.url==='/play/projects/1') { res.writeHead(200,{...playShellHeaders(config),'Content-Type':'text/html'});return res.end(renderPlayShell(config,1)); }
 if(req.method==='POST'&&req.url.startsWith('/api/webgl-play/sessions')) {
  if(req.url.endsWith('/renew')) { renewals++;assert.equal(req.headers['x-pcu-play-control'],controlSecret);return json(res,denyRenew?403:200,{expiresAt:new Date(Date.now()+900000).toISOString(),absoluteExpiresAt:new Date(Date.now()+28800000).toISOString()}); }
  if(req.url.endsWith('/close')) { closes++;assert.equal(req.headers['x-pcu-play-control'],controlSecret);return json(res,200,{closed:true}); }
  creates++;return json(res,200,{id:'11111111-1111-4111-8111-111111111111',controlSecret,iframeUrl:`${assetOrigin}/runtime/${token}/index.html`,projectTitle:title,webglDisplayKind:displayKind,webglDisplayWidth:dimensions[0],webglDisplayHeight:dimensions[1],expiresAt:new Date(Date.now()+900000).toISOString(),absoluteExpiresAt:new Date(Date.now()+28800000).toISOString()});
 }
 res.writeHead(404);res.end();
});
apiOrigin=origin(api);
const assets=await serve((req,res)=>{
 assetRequests.push({control:req.headers['x-pcu-play-control'],cookie:!!req.headers.cookie,url:req.url});
 if(req.url.includes(otherToken))otherRequests++;
 res.writeHead(200,{'Content-Type':req.url.endsWith('.js')?'application/javascript':'text/html','Content-Security-Policy':runtimeCsp(assetOrigin,token,apiOrigin),'Cross-Origin-Resource-Policy':'cross-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Opener-Policy':'same-origin','Cache-Control':'no-store'});
 if(req.url.endsWith('worker.js'))return res.end('postMessage({isolated:crossOriginIsolated,sab:typeof SharedArrayBuffer===\'function\'});');
 loads++;
 res.end(`<!doctype html><html><body style="margin:0"><canvas style="position:absolute;width:100%;height:100%"></canvas><script>
 window.probe={id:Math.random(),isolated:crossOriginIsolated,sab:typeof SharedArrayBuffer==='function',parentBlocked:false,clicks:[],moves:[],keys:[]};
 try{parent.document.body}catch{probe.parentBlocked=true}
 let dragging=false;
 onpointerdown=e=>{dragging=true;probe.clicks.push([e.clientX,e.clientY])};
 onpointermove=e=>{if(dragging)probe.moves.push([e.clientX,e.clientY])};onpointerup=()=>dragging=false;
 onkeydown=e=>{probe.keys.push(e.key);if(e.key==='f')document.querySelector('canvas').requestFullscreen()};
 const worker=new Worker('./worker.js');worker.onmessage=e=>probe.worker=e.data;worker.onerror=e=>probe.workerError=e.message;
 </script></body></html>`);
});
assetOrigin=origin(assets);config={API_PUBLIC_URL:apiOrigin,WEB_PUBLIC_URL:apiOrigin,PUBLIC_ASSET_ORIGIN:assetOrigin};
let browser;
const matrix=[];
try{
 browser=await playwright[engine].launch({headless:true,timeout:20000,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),...(engine==='chromium'?{args:['--no-sandbox']}: {})});
 for(const [width,height] of [[1280,720],[720,1280],[800,600],[null,null]]){
  displayKind=width===null?'responsive':'fixed';
  dimensions=[width,height];denyRenew=false;
  const context=await browser.newContext({viewport:{width:1800,height:1200},deviceScaleFactor:2});
  await context.addCookies([{name:'fixture_cookie',value:'present',url:assetOrigin}]);
  await context.addInitScript(()=>{window.cspViolations=[];document.addEventListener('securitypolicyviolation',event=>window.cspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));});
  const page=await context.newPage();await page.clock.install();
  await page.goto(`${apiOrigin}/play/projects/1`);
  // Headless software rendering may intentionally hold startup. Exercise the real
  // explicit continuation control instead of bypassing the production probe.
  await page.locator('#game iframe, #acceleration-gate:not([hidden])').first().waitFor();
  if (await page.locator('#acceleration-gate').isVisible()) {
   await page.locator('#acceleration-continue').click();
  }
  const iframe=page.locator('#game iframe');await iframe.waitFor();
  const game=await (await iframe.elementHandle()).contentFrame();await game.waitForFunction(()=>window.probe?.worker||window.probe?.workerError);
  const first={creates,loads,id:await game.evaluate(()=>probe.id),src:await iframe.getAttribute('src')};
  assert.equal(await page.locator('#title').textContent(),title);assert.equal(await page.locator('#title img').count(),0);assert.equal(await page.evaluate(()=>!!window.titleInjected),false);
  assert.equal(await iframe.getAttribute('credentialless'),'');assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts allow-pointer-lock allow-same-origin');assert.match(await iframe.getAttribute('allow'),/cross-origin-isolated/);
  assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
  const child=await game.evaluate(()=>probe);assert.equal(child.isolated,true);assert.equal(child.sab,true);assert.equal(child.parentBlocked,true);assert.deepEqual(child.worker,{isolated:true,sab:true});
  assert.equal(await page.evaluate(()=>{try{document.querySelector('iframe').contentWindow.document.body;return false}catch{return true}}),true);
  assert.equal(await game.evaluate(secret=>document.documentElement.outerHTML.includes(secret),controlSecret),false);
  async function measure(name,fullscreen=false){
   await new Promise(resolve=>setTimeout(resolve,150));
   const stage=await page.locator('#game').boundingBox(),box=await iframe.boundingBox();
   assert(box.width<=stage.width+1.5&&box.height<=stage.height+1.5,JSON.stringify({name,stage,box}));
   if(displayKind==='fixed'){
    if(!fullscreen)assert(box.width<=width+1.5&&box.height<=height+1.5);
    assert(Math.abs(box.width/box.height-width/height)<.01);
   }else{
    assert(Math.abs(box.width-stage.width)<1.5&&Math.abs(box.height-stage.height)<1.5);
   }
   assert(Math.abs(box.x+box.width/2-stage.x-stage.width/2)<1.5);assert(Math.abs(box.y+box.height/2-stage.y-stage.height/2)<1.5);
   const inner=await game.evaluate(()=>[innerWidth,innerHeight]);
   if(displayKind==='fixed')assert.deepEqual(inner,[width,height]);
   else assert(Math.abs(inner[0]-stage.width)<=1&&Math.abs(inner[1]-stage.height)<=1);
   const [inputWidth,inputHeight]=inner;
   const scale=box.width/inputWidth;
   for(const [fx,fy] of [[.02,.02],[.98,.02],[.02,.98],[.98,.98],[.5,.5]]){
    await page.mouse.click(box.x+box.width*fx,box.y+box.height*fy);const p=await game.evaluate(()=>probe.clicks.at(-1));
    assert(Math.abs(p[0]-inputWidth*fx)*scale<=1.5&&Math.abs(p[1]-inputHeight*fy)*scale<=1.5,JSON.stringify({name,box,p,fx,fy,width,height}));
   }
   await page.mouse.move(box.x+box.width*.25,box.y+box.height*.25);await page.mouse.down();await page.mouse.move(box.x+box.width*.75,box.y+box.height*.75,{steps:5});await page.mouse.up();
   const last=await game.evaluate(()=>probe.moves.at(-1));assert(Math.abs(last[0]-inputWidth*.75)*scale<=1.5&&Math.abs(last[1]-inputHeight*.75)*scale<=1.5);
   await page.keyboard.press('a');assert((await game.evaluate(()=>probe.keys)).includes('a'));
   assert.equal(creates,first.creates);assert.equal(loads,first.loads);assert.equal(await game.evaluate(()=>probe.id),first.id);assert.equal(await iframe.getAttribute('src'),first.src);
   matrix.push({kind:displayKind,width,height,name,iframe:{width:box.width,height:box.height},stage:{width:stage.width,height:stage.height}});
  }
  for(const viewport of [{width:1800,height:1200},{width:900,height:650},{width:600,height:450}]){await page.setViewportSize(viewport);await measure(`${viewport.width}x${viewport.height}`)}
  await page.setViewportSize({width:1800,height:1200});await page.locator('#fullscreen').click();await page.waitForFunction(()=>!!document.fullscreenElement);await measure('host-fullscreen',true);
  await page.locator('#fullscreen').click();await page.waitForFunction(()=>!document.fullscreenElement);await measure('host-exit');
  await page.keyboard.press('f');await game.waitForFunction(()=>!!document.fullscreenElement);
  assert.equal(await page.evaluate(()=>document.fullscreenElement?.tagName),'IFRAME');
  assert.equal(creates,first.creates);assert.equal(loads,first.loads);assert.equal(await game.evaluate(()=>probe.id),first.id);
  await game.evaluate(()=>document.exitFullscreen());await game.waitForFunction(()=>!document.fullscreenElement);await measure('game-exit');
  const shellViolations=await page.evaluate(()=>window.cspViolations);
  // Firefox also emits this exact implicit favicon violation on the pre-sizing shell.
  // Keep the existing CSP restrictive; never ignore script/style/frame violations.
  const sizingViolations=shellViolations.filter(violation=>{
   if(violation.directive==='img-src'&&violation.blocked===`${apiOrigin}/favicon.ico`){baselineFaviconViolations.push(violation);return false}
   return true;
  });
  assert.deepEqual(sizingViolations,[]);assert.deepEqual(await game.evaluate(()=>window.cspViolations),[]);
  assert.ok(assetRequests.every(r=>!r.control&&!r.url.includes(controlSecret)));
  // Deterministically exercise the existing visibility-based authority recheck.
  await page.evaluate(()=>{window.testVisibility='visible';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.testVisibility});});
  const initial=renewals;await page.clock.fastForward(60001);await new Promise(resolve=>setTimeout(resolve,100));assert(renewals>initial);assert.equal(await iframe.getAttribute('src'),first.src);
  const after=renewals;await page.evaluate(()=>{window.testVisibility='hidden';document.dispatchEvent(new Event('visibilitychange'))});await page.clock.fastForward(120000);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(renewals,after);
  // Expected deliberate CSP violation is checked separately after normal sizing behavior.
  await page.evaluate(url=>{const frame=document.createElement('iframe');frame.src=url;document.body.append(frame)},`${assetOrigin}/runtime/${otherToken}/index.html`);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(otherRequests,0);
  denyRenew=true;await page.evaluate(()=>{window.testVisibility='visible';document.dispatchEvent(new Event('visibilitychange'))});await page.waitForFunction(()=>document.querySelectorAll('#game iframe').length===0);assert.match(await page.locator('#status').textContent(),/만료|변경/);assert.equal(await page.locator('#restart').isDisabled(),false);
  await context.close();
 }
 console.log(JSON.stringify({engine,version:browser.version(),passed:true,matrix,creates,loads,renewals,closes,baselineFaviconViolations,assetRequestsWithCookie:assetRequests.filter(r=>r.cookie).length,checks:['fit, center, aspect ratio','corner/center clicks, drag, keyboard','host/game fullscreen and resize preserve iframe, game and session','strict shell CSP has no sizing violations','Worker/SAB isolation, escaped title, no control secret to assets','visible renew, hidden pause, forbidden renew stops runtime','wrong runtime-directory iframe blocked'],limits:['Synthetic canvas and Worker, not actual Unity','Mock session controls, not authenticated API acceptance','Loopback secure context, not production gateway/TLS','visibilityState overridden only for deterministic authority test','Only pre-existing Firefox implicit favicon.ico img-src violation is exempted and recorded']},null,2));
}finally{await browser?.close();await Promise.all([api,assets].map(server=>new Promise(resolve=>server.close(resolve))));}
