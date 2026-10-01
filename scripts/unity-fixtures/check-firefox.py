import urllib.request,urllib.parse,json,pathlib,time,base64,os,sys
root=pathlib.Path(os.environ.get('FIXTURE_ROOT','/tmp/pcu-unity-fixture-repro')).resolve();out=root/'results';out.mkdir(exist_ok=True);base=os.environ.get('WEBDRIVER_URL','http://127.0.0.1:19013')
if urllib.parse.urlparse(base).hostname not in ['127.0.0.1','localhost']:raise ValueError('WebDriver must use loopback')
def req(path,payload=None,method=None):
 data=json.dumps(payload).encode() if payload is not None else None
 r=urllib.request.urlopen(urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json'},method=method),timeout=90)
 value=json.load(r)['value']
 if isinstance(value,dict) and 'error' in value:raise ValueError(value)
 return value
session=req('/session',{'capabilities':{'alwaysMatch':{'browserName':'firefox','moz:firefoxOptions':{'binary':os.environ.get('FIREFOX_EXECUTABLE','/run/current-system/sw/bin/firefox'),'args':['-headless'],'prefs':{'webgl.force-enabled':True}},'pageLoadStrategy':'eager'}}})
sid=session['sessionId'];cap=session['capabilities'];print('firefox',cap['browserVersion'],flush=True)
prefix='/session/'+sid
req(prefix+'/window/rect',{'width':1100,'height':800})
req(prefix+'/timeouts',{'script':70000,'pageLoad':60000})
configs=os.environ.get('FIXTURE_CONFIGS');configs=configs.split(',') if configs else sorted(p.name for p in (root/'published').iterdir());results=[]
try:
 for fixture in configs:
  errors=[];status='loaded'
  try:
   parent_state=None
   if os.environ.get('TRUSTED_SHELL')=='true':
    entries=json.load(urllib.request.urlopen('http://127.0.0.1:19012/fixture-list'))
    shell=next(e['shellUrl'] for e in entries if e['name']==fixture)
    req(prefix+'/url',{'url':shell})
    parent_state=req(prefix+'/execute/sync',{'script':'return {isolated:crossOriginIsolated,sab:typeof SharedArrayBuffer==="function"}','args':[]})
    frame=None
    for attempt in range(30):
     try: frame=req(prefix+'/element',{'using':'css selector','value':'#game iframe'});break
     except Exception:time.sleep(.2)
    if not frame:raise ValueError('Trusted shell did not create a game iframe')
    req(prefix+'/frame',{'id':frame})
   else: req(prefix+'/url',{'url':f'http://127.0.0.1:19011/{fixture}/index.html'})
   ready=req(prefix+'/execute/async',{'script':'''const done=arguments[arguments.length-1];const start=Date.now();const timer=setInterval(()=>{if(window.__fixture?.ready||window.__fixture?.blocked||Date.now()-start>60000){clearInterval(timer);done({ready:!!window.__fixture?.ready,state:window.__fixture})}},200);''','args':[]})
   if not ready['ready']:status='failed';errors.append('Unity instance timeout')
   time.sleep(2.5)
   if fixture.startswith('threaded-gltf'):
    req(prefix+'/execute/sync',{'script':"window.__fixture.externalBlocked=false;addEventListener('securitypolicyviolation',e=>{if(e.blockedURI.startsWith('https://raw.githubusercontent.com/'))__fixture.externalBlocked=true});window.viewer.onModelLoaded=success=>__fixture.modelLoaded=Boolean(success);window.viewer.updateStopWatch=()=>{};window.viewer.loadGltf('https://raw.githubusercontent.com/KhronosGroupArchives/glTF-Sample-Models/d7a3cc8e51d7c573771ae77a57f16b0662a905c6/2.0/Box/glTF-Binary/Box.glb');return true",'args':[]})
    time.sleep(1)
    blocked=req(prefix+'/execute/sync',{'script':'return __fixture.externalBlocked','args':[]})
    if not blocked: raise ValueError('external request was not blocked by CSP')
    req(prefix+'/execute/sync',{'script':"__fixture.modelLoaded=null;viewer.loadGltf(new URL('StreamingAssets/Box.glb',location.href).href);return true",'args':[]})
    loaded=req(prefix+'/execute/async',{'script':"const done=arguments[arguments.length-1];const start=Date.now();const timer=setInterval(()=>{if(__fixture.modelLoaded===true||Date.now()-start>20000){clearInterval(timer);done(__fixture.modelLoaded)}},200);",'args':[]})
    if loaded is not True: raise ValueError('local glTF model did not load')
    time.sleep(1.5)
   req(prefix+'/actions',{'actions':[{'type':'key','id':'keyboard','actions':[{'type':'keyDown','value':'\ue014'},{'type':'pause','duration':300},{'type':'keyUp','value':'\ue014'}]}]})
  except Exception as e:status='failed';errors.append(str(e))
  state=req(prefix+'/execute/sync',{'script':'return {fixture:window.__fixture,isolated:crossOriginIsolated,userAgent:navigator.userAgent,canvas:Array.from(document.querySelectorAll("canvas"),c=>({width:c.width,height:c.height,clientWidth:c.clientWidth,clientHeight:c.clientHeight})),resources:performance.getEntriesByType("resource").map(e=>({name:e.name,transferSize:e.transferSize,decodedBodySize:e.decodedBodySize}))}','args':[]})
  if not state.get('fixture',{}).get('ready') or not any(c['width']>0 and c['height']>0 for c in state.get('canvas',[])):status='failed'
  if fixture.startswith('threaded-gltf'):
   f=state.get('fixture',{})
   if not (state.get('isolated') and f.get('sab') and f.get('externalBlocked') and f.get('modelLoaded') and any('loaded' in w['messages'] for w in f.get('workers',[]))):status='failed'
   if os.environ.get('TRUSTED_SHELL')=='true' and not (parent_state['isolated'] and parent_state['sab'] and f.get('parentBlocked')):status='failed'
  try: screenshot=req(prefix+'/screenshot');(out/('firefox-'+fixture+('.png' if status=='loaded' else '-failed.png'))).write_bytes(base64.b64decode(screenshot))
  except Exception as e:errors.append(str(e))
  if os.environ.get('TRUSTED_SHELL')=='true':req(prefix+'/frame',{'id':None})
  results.append({'browser':'firefox','version':cap['browserVersion'],'binary':os.environ.get('FIREFOX_EXECUTABLE','/run/current-system/sw/bin/firefox'),'fixture':fixture,'status':status,'state':state,'parentState':parent_state,'errors':errors});(out/('firefox'+os.environ.get('RESULT_SUFFIX','')+'.json')).write_text(json.dumps(results,indent=2));print('firefox',fixture,status,'ready',state.get('fixture',{}).get('ready'),'workers',len(state.get('fixture',{}).get('workers',[])),flush=True)
finally:req(prefix,method='DELETE')

if any(r["status"]!="loaded" for r in results):sys.exit(1)
