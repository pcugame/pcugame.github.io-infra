"use strict";
(function(){
function report(stage,memory){self.postMessage({__pcuWorkerProbe:{stage,isolated:self.crossOriginIsolated,sab:typeof SharedArrayBuffer==='function',realm:self.constructor.name,secure:self.isSecureContext,href:self.location.href,memoryShared:memory ? memory.buffer instanceof SharedArrayBuffer : null,memoryBytes:memory ? memory.buffer.byteLength : null}});}
report('startup');
self.addEventListener('message',function(e){if(e.data?.cmd==='load')report('native-load',e.data.wasmMemory);if(e.data?.cmd==='run')report('native-run',Module?.wasmMemory);});
})();
