// ── Google Identity Services 초기화 ──────────────────────────
// https://developers.google.com/identity/gsi/web/reference/js-reference

import { env } from '../env';

/**
 * Google Identity Services 스크립트를 로드하고 초기화한다.
 * 콜백으로 credential(ID token)을 전달한다.
 */
export function initializeGoogleSignIn(
  buttonElement: HTMLElement,
  onCredential: (credential: string) => void,
) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('VITE_GOOGLE_CLIENT_ID가 설정되지 않았습니다.');
    return;
  }

  // 이미 로드된 경우
  if (window.google?.accounts?.id) {
    renderButton(buttonElement, onCredential, clientId);
    return;
  }

  // 스크립트 동적 로드
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  script.onload = () => {
    renderButton(buttonElement, onCredential, clientId);
  };
  document.head.appendChild(script);
}

function renderButton(
  el: HTMLElement,
  onCredential: (credential: string) => void,
  clientId: string,
) {
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (response: { credential: string }) => {
      onCredential(response.credential);
    },
  });

  window.google.accounts.id.renderButton(el, {
    theme: 'outline',
    size: 'large',
    text: 'signin_with',
    locale: 'ko',
  });
}

// ── Google Identity 타입 선언 ────────────────────────────────

declare global {
  interface Window {
    google: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            element: HTMLElement,
            options: {
              theme?: string;
              size?: string;
              text?: string;
              locale?: string;
            },
          ) => void;
          prompt: () => void;
        };
      };
    };
  }
}
