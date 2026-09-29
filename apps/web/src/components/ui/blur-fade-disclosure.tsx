import * as React from 'react';

import './blur-fade-disclosure.css';

type Phase = 'closed' | 'opening' | 'open' | 'closing';

const CLOSE_DURATION_MS = 240;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface BlurFadeDisclosureProps extends Omit<React.ComponentProps<'details'>, 'children' | 'open'> {
  summary: React.ReactNode;
  children: React.ReactNode;
  contentClassName?: string;
}

/** Keeps a native disclosure open until its content has finished blurring away. */
export function BlurFadeDisclosure({
  summary,
  children,
  className,
  contentClassName,
  ...props
}: BlurFadeDisclosureProps) {
  const [phase, setPhase] = React.useState<Phase>('closed');
  const closeTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (phase !== 'opening') return;
    const frame = window.requestAnimationFrame(() => setPhase('open'));
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  React.useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  const toggle = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }

    if (phase === 'closed' || phase === 'closing') {
      setPhase(prefersReducedMotion() ? 'open' : 'opening');
    } else if (prefersReducedMotion()) {
      setPhase('closed');
    } else {
      setPhase('closing');
      closeTimer.current = window.setTimeout(() => {
        setPhase('closed');
        closeTimer.current = null;
      }, CLOSE_DURATION_MS);
    }
  };

  return (
    <details
      {...props}
      className={['blur-fade-disclosure', className].filter(Boolean).join(' ')}
      open={phase !== 'closed'}
      data-disclosure-phase={phase}
      data-expanded={phase === 'opening' || phase === 'open'}
    >
      <summary onClick={toggle}>{summary}</summary>
      <div className="blur-fade-disclosure__motion">
        <div className="blur-fade-disclosure__inner">
          {contentClassName ? <div className={contentClassName}>{children}</div> : children}
        </div>
      </div>
    </details>
  );
}
