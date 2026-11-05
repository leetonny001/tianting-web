import { Logo } from './Logo';

/** 宽屏主区空态（PRD-ui 3.3 节）：天听 Logo 和一句提示。 */
export function WideEmpty({ text }: { text?: string }) {
  return (
    <div className="tt-wide-empty" data-testid="main-empty">
      <Logo />
      {text && <p>{text}</p>}
    </div>
  );
}
