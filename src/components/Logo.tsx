import { APP_NAME } from '../lib/config';

export function Logo() {
  return (
    <div className="tt-logo">
      <span className="tt-logo-mark" aria-hidden="true">
        听
      </span>
      <span className="tt-logo-name">{APP_NAME}</span>
    </div>
  );
}
