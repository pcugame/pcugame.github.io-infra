/** Keep controls outside the scrolling code so they remain visible on narrow screens. */
document.querySelectorAll('pre > code').forEach((code) => {
  const pre = code.parentElement;
  const wrapper = document.createElement('div');
  wrapper.className = 'guide-code-block';
  pre.before(wrapper);

  const toolbar = document.createElement('div');
  toolbar.className = 'guide-code-toolbar';
  const language = document.createElement('span');
  language.className = 'guide-code-language';
  language.textContent = code.classList.contains('language-csharp') ? 'C#' : '코드';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'guide-code-copy';
  button.setAttribute('aria-label', '코드 복사');
  button.innerHTML = '<svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  const label = document.createElement('span');
  label.textContent = '복사';
  label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  button.append(label);

  let resetTimer;
  button.addEventListener('click', async () => {
    clearTimeout(resetTimer);
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.dataset.state = 'copied';
      label.textContent = '복사됨';
      button.setAttribute('aria-label', '코드 복사됨');
    } catch {
      button.dataset.state = 'error';
      label.textContent = '복사 실패';
      button.setAttribute('aria-label', '복사 실패. 다시 시도하거나 코드를 직접 선택해 복사하세요.');
    } finally {
      button.disabled = false;
      resetTimer = setTimeout(() => {
        delete button.dataset.state;
        label.textContent = '복사';
        button.setAttribute('aria-label', '코드 복사');
      }, 2000);
    }
  });

  toolbar.append(language, button);
  wrapper.append(toolbar, pre);
});
