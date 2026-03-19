import { getApiErrorMessage } from '../../lib/api';

interface Props {
  error: unknown;
  resetLabel?: string;
  onReset?: () => void;
}

export function ErrorMessage({ error, resetLabel = '다시 시도', onReset }: Props) {
  return (
    <div className="error-box" role="alert">
      <p className="error-box__message">{getApiErrorMessage(error)}</p>
      {onReset && (
        <button className="btn btn--secondary" onClick={onReset}>
          {resetLabel}
        </button>
      )}
    </div>
  );
}
