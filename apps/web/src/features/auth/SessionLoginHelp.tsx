import { isMacSafari } from './browser';

export function SessionLoginHelp() {
  if (!isMacSafari(navigator.userAgent)) {
    return <p>브라우저의 쿠키 설정을 확인하거나 다른 브라우저에서 로그인을 시도해 주세요.</p>;
  }

  return (
    <div className="login-session-help">
      <p>현재 서비스 구성에서는 Safari의 개인정보 보호 설정으로 인해 Google 계정을 선택한 뒤에도 로그인이 완료되지 않을 수 있습니다.</p>
      <p>Safari → 설정 → 개인정보 보호에서 ‘크로스 사이트 추적 방지’를 잠시 해제한 뒤, 페이지를 새로고침하고 다시 로그인해 보세요.</p>
      <p>이 설정은 다른 사이트에도 적용됩니다. 설정 변경을 원하지 않으면 Mac의 다른 브라우저에서 로그인을 시도해 주세요. 설정을 다시 켜면 이 사이트의 로그인이 유지되지 않을 수 있습니다.</p>
      <a href="https://support.apple.com/ko-kr/guide/safari/sfri40732/mac" target="_blank" rel="noopener noreferrer">Apple의 Safari 개인정보 보호 설정 안내</a>
    </div>
  );
}
