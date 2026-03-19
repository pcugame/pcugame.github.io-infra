export function LoadingSpinner({ message = '불러오는 중…' }: { message?: string }) {
  return (
    <div className="page-center">
      <div className="spinner" aria-label="로딩 중" />
      <p>{message}</p>
    </div>
  );
}
