// Presentation mirrors the existing web GraphicsAccelerationGate/Guide/Screenshot.
// Keep their copy, markup and graphics-only CSS aligned when changing either surface.
export const accelerationStyle = `
:root { font-size:125%; font-family:'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; line-height:1.6; -webkit-font-smoothing:antialiased; --color-primary:#1a51af; --color-primary-btn:#2461d4; }
*, *::before, *::after { box-sizing:border-box; }
.graphics-gate, .graphics-screenshot-dialog { color-scheme:light; overflow-wrap:anywhere; word-break:break-word; }
.graphics-gate *, .graphics-screenshot-dialog * { margin:0; padding:0; }
.graphics-gate :where(a) { text-decoration:none; }
.graphics-gate a:hover { text-decoration:underline; }
.graphics-gate img, .graphics-screenshot-dialog img { max-width:100%; }
html:has(.graphics-gate[open]), body:has(.graphics-gate[open]) { overflow:hidden; scrollbar-gutter:auto; }
#acceleration-gate[hidden], #guide-enlarged[hidden], .graphics-gate [hidden] { display:none; }
/* ── Buttons ──────────────────────────────────────────────────── */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 0.5rem 1.1rem;
  font-size: 0.88rem;
  font-weight: 600;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
  text-decoration: none;
  line-height: 1.4;
  font-family: inherit;
}

.btn:hover {
  text-decoration: none;
}

.btn:active:not(:disabled) {
  transform: scale(0.96);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
}

.btn--primary {
  background: var(--color-primary-btn, var(--color-primary));
  color: #fff;
  box-shadow: 0 2px 8px rgba(26, 81, 175, 0.2);
}

.btn--primary:hover:not(:disabled) {
  background: var(--color-primary);
  box-shadow: 0 4px 16px rgba(26, 81, 175, 0.3);
  transform: translateY(-1px);
}

.graphics-gate {
  width: min(27rem, calc(100vw - 2rem));
  max-width: none;
  max-height: calc(100dvh - 2rem);
  margin: auto;
  padding: 0;
  border: 1px solid #e2e8f0;
  border-radius: 22px;
  background: #fff;
  color: #172033;
  font-size: 0.75rem;
  box-shadow: 0 32px 100px #0005;
}
.graphics-gate::backdrop { background: #111827b8; backdrop-filter: blur(6px); }
.graphics-gate { overflow: hidden; padding-top: 2.3rem; }
.graphics-gate[open] { display: flex; flex-direction: column; }
.graphics-gate__body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: #cbd5e1 transparent;
  margin: 0 0.35rem 0.5rem;
  padding: 0 1.15rem 0.75rem;
}
.graphics-gate__body:hover { scrollbar-color: #94a3b8 transparent; }
.graphics-gate__body::-webkit-scrollbar { width: 6px; }
.graphics-gate__body::-webkit-scrollbar-track { background: transparent; }
.graphics-gate__body::-webkit-scrollbar-thumb { border-radius: 999px; background: #cbd5e1; }
.graphics-gate__body::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
.graphics-gate__close { position: absolute; top: 0.3rem; right: 0.5rem; width: 1.7rem; height: 1.7rem; border: 0; border-radius: 50%; background: #f8fafc; color: #64748b; font-size: 1.1rem; cursor: pointer; }
.graphics-gate__close:hover { background: #f1f5f9; }
.graphics-gate__icon { display: grid; place-items: center; width: 2.7rem; height: 2.7rem; margin-bottom: 0.9rem; border-radius: 15px; background: #edf3ff; color: #2563eb; }
.graphics-gate__eyebrow { color: #2563eb; font-size: 0.65rem; font-weight: 700; }
.graphics-gate h2 { color: #172033; margin: 0.35rem 0 0.6rem; font-size: 1.2rem; line-height: 1.4; letter-spacing: -0.04em; word-break: keep-all; }
.graphics-gate p { margin: 0; line-height: 1.6; }
.graphics-gate__description { color: #64748b; word-break: keep-all; }
.graphics-gate .graphics-gate__note { margin-top: 1rem; color: #64748b; font-size: 0.65rem; }
.graphics-gate__result:not(:empty) { margin-top: 0.7rem; color: #9a5b0b; font-size: 0.7rem; }
.graphics-gate__footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.9rem 1.5rem; border-top: 1px solid #e8edf4; background: #f8fafc; }
.graphics-gate__footer .btn { padding: 0.65rem 0.8rem; font-size: 0.7rem; white-space: nowrap; }
.graphics-gate__continue { background: none; border: none; padding: 0.5rem 0; color: #64748b; font: inherit; font-size: 0.7rem; cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }
.graphics-gate__stage { flex: 1; min-height: 65vh; display: grid; place-items: center; border: 1px solid #253049; border-radius: 12px; background: radial-gradient(ellipse at center, #17243c, #0d1320 70%); color: #8494af; font-size: 0.8rem; }
.graphics-guide { margin-top: 1.1rem; font-size: 0.75rem; }
.graphics-guide__browser { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem; font-weight: 650; color: inherit; }
.graphics-guide__browser span { color: #64748b; font-size: 0.65rem; font-weight: 400; }
.graphics-guide__steps { padding: 0.85rem 0.85rem 0.85rem 2rem; margin: 0.6rem 0; border: 1px solid #e5eaf3; border-radius: 12px; background: #f5f7fb; color: #334155; }
.graphics-guide__steps li { line-height: 1.55; padding-left: 0.2rem; }
.graphics-guide__steps li + li { margin-top: 0.5rem; }
.graphics-guide__steps li::marker { color: #2563eb; font-weight: 700; }
.graphics-guide__link { display: inline-flex; margin-top: 0.35rem; color: #2563eb; font-size: 0.7rem; font-weight: 600; text-decoration: underline; text-underline-offset: 4px; }
.graphics-guide__override { margin-top: 0.75rem; color: #64748b; font-size: 0.65rem; }
.graphics-guide__override summary { cursor: pointer; }
.graphics-guide__override label { display: block; margin: 0.5rem 0 0.3rem; }
.graphics-guide select { width: 100%; padding: 0.5rem; background: #fff; color: #334155; border: 1px solid #cbd5e1; border-radius: 7px; font: inherit; }
.graphics-guide :is(select, a):focus-visible, .graphics-gate button:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
.project-play-page__help .graphics-guide__link { color: #93c5fd; }
.graphics-screenshot { margin: 0.8rem 0; }
.graphics-screenshot__preview { display: block; overflow: hidden; width: 100%; padding: 0; border: 1px solid #dce4f0; border-radius: 10px; background: #f8fafc; color: #2563eb; cursor: zoom-in; text-align: left; }
.graphics-screenshot__preview img { display: block; width: 100%; height: auto; }
.graphics-screenshot__preview > span { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.65rem; border-top: 1px solid #e8edf4; font-size: 0.65rem; font-weight: 600; }
.graphics-screenshot figcaption { margin-top: 0.35rem; color: #64748b; font-size: 0.6rem; line-height: 1.5; }
.graphics-screenshot-dialog { width: min(52rem, calc(100% - 1rem)); max-width: none; max-height: calc(100dvh - 1rem); padding: 0; overflow: hidden; border: 1px solid #e2e8f0; border-radius: 16px; background: #fff; color: #172033; box-shadow: 0 30px 100px #0006; }
.graphics-screenshot-dialog[open] { display: flex; flex-direction: column; }
.graphics-screenshot-dialog::backdrop { background: #0f172abf; backdrop-filter: blur(4px); }
.graphics-screenshot-dialog__header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.6rem 1rem; border-bottom: 1px solid #e8edf4; font-size: 0.8rem; }
.graphics-screenshot-dialog__header button { width: 1.7rem; height: 1.7rem; border: 0; border-radius: 50%; background: #f1f5f9; color: #475569; font-size: 1.1rem; cursor: pointer; }
.graphics-screenshot-dialog__content { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent; }
.graphics-screenshot-dialog__content img { display: block; width: 100%; height: auto; }
.graphics-screenshot-dialog > p { flex-shrink: 0; margin: 0; padding: 0.65rem 1rem; color: #64748b; font-size: 0.65rem; line-height: 1.5; }
.graphics-screenshot button:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
@media (max-width: 480px) {
  .graphics-gate { width: calc(100vw - 1rem); max-height: calc(100dvh - 1rem); border-radius: 18px; }
  .graphics-gate__body { padding: 0 0.65rem 0.65rem; }
  .graphics-gate__footer { padding: 0.8rem 1rem; }
  .graphics-gate h2 { font-size: 1.1rem; }
}

@media (max-width:50em) { .graphics-gate .btn { min-height:2.5rem; } .graphics-gate .btn--primary { box-shadow:none; } }
`;

export const accelerationMarkup = `<dialog id="acceleration-gate" class="graphics-gate" hidden aria-labelledby="acceleration-title" aria-describedby="acceleration-description">
<button id="acceleration-close" type="button" class="graphics-gate__close" aria-label="플레이 취소하고 작품으로 돌아가기">×</button>
<div class="graphics-gate__body"><div class="graphics-gate__icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="18" height="11" rx="2"/><circle cx="12" cy="11.5" r="3.5"/><path d="M12 8v2m3.5 1.5h-2M12 15v-2m-3.5-1.5h2M2 4h2v15H2m6-2v3h8v-3m-5 0v3m3-3v3m4-11h1m-1 3h1"/></svg></div>
<span class="graphics-gate__eyebrow">플레이 준비</span><h2 id="acceleration-title">그래픽 가속 설정을 확인해 주세요</h2><p id="acceleration-description" class="graphics-gate__description">그래픽카드가 쉬고 있을 수 있어요. 그래픽 가속을 켜면 더 부드럽게 플레이할 수 있어요.</p>
<div class="graphics-guide"><p class="graphics-guide__browser"><strong id="guide-name"></strong><span id="guide-detection"></span></p><ol id="guide-steps" class="graphics-guide__steps"></ol><p id="guide-address-row">주소창에 <code id="guide-address"></code>을 입력해 설정을 열 수 있어요.</p>
<figure id="guide-screenshot" class="graphics-screenshot" hidden><button id="guide-preview" type="button" class="graphics-screenshot__preview" aria-label="설정 화면 크게 보기"><img id="guide-image" crossorigin="anonymous" alt="" loading="lazy"><span>설정 화면 크게 보기 <span aria-hidden="true">⤢</span></span></button><figcaption id="guide-caption"></figcaption></figure>
<p id="guide-note"></p><a id="guide-help" class="graphics-guide__link">설정 방법 보기</a><details class="graphics-guide__override"><summary>다른 브라우저 안내</summary><label for="guide-browser">사용 중인 브라우저</label><select id="guide-browser"><option value="chrome">Chrome</option><option value="edge">Edge</option><option value="brave">Brave</option><option value="firefox">Firefox</option><option value="whale">Whale</option><option value="opera">Opera</option><option value="safari">Safari</option><option value="other">기타 브라우저</option><option value="mobile">모바일 브라우저</option></select></details></div>
<p class="graphics-gate__note">설정이 이미 켜져 있다면 기기나 그래픽 드라이버의 문제일 수 있어요.</p><p id="acceleration-result" class="graphics-gate__result" role="status"></p></div>
<div class="graphics-gate__footer"><button id="acceleration-continue" type="button" class="graphics-gate__continue">그래도 실행</button><button id="acceleration-retry" type="button" class="btn btn--primary">설정 후 다시 확인 <span aria-hidden="true">↻</span></button></div></dialog>
<dialog id="guide-enlarged" class="graphics-screenshot-dialog" hidden aria-label="브라우저 설정 화면" aria-describedby="guide-enlarged-caption"><div class="graphics-screenshot-dialog__header"><strong>브라우저 설정 화면</strong><button id="guide-enlarged-close" type="button" aria-label="확대 이미지 닫기">×</button></div><div class="graphics-screenshot-dialog__content"><img id="guide-enlarged-image" crossorigin="anonymous" alt=""></div><p id="guide-enlarged-caption"></p></dialog>`;
