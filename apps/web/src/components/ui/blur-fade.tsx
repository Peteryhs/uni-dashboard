import * as React from 'react';

import './blur-fade.css';

type BlurFadeElement = 'div' | 'section' | 'article' | 'span';
type BlurFadeDirection = 'up' | 'down' | 'left' | 'right';

export interface BlurFadeProps extends React.HTMLAttributes<HTMLElement> {
  /** The element used as the animation wrapper. */
  as?: BlurFadeElement;
  children: React.ReactNode;
  /** Delay before the reveal, in seconds. */
  delay?: number;
  /** Reveal duration, in seconds. */
  duration?: number;
  /** Starting blur amount, for example `6px` or `0`. */
  blur?: string;
  /** Starting translation direction. */
  direction?: BlurFadeDirection;
  /** Starting translation distance, in pixels. */
  offset?: number;
  /** Observe the wrapper and reveal it once it enters the viewport. */
  inView?: boolean;
  /** IntersectionObserver root margin used when `inView` is enabled. */
  inViewMargin?: string;
}

const DEFAULT_DURATION = 0.4;
const DEFAULT_OFFSET = 6;
const DEFAULT_BLUR = '6px';
const DEFAULT_IN_VIEW_MARGIN = '-50px';

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function supportsIntersectionObserver() {
  return typeof window !== 'undefined' && 'IntersectionObserver' in window;
}

const BlurFade = React.forwardRef<HTMLElement, BlurFadeProps>(function BlurFade(
  {
    as: Element = 'div',
    blur = DEFAULT_BLUR,
    children,
    className,
    delay = 0,
    direction = 'down',
    duration = DEFAULT_DURATION,
    inView = false,
    inViewMargin = DEFAULT_IN_VIEW_MARGIN,
    offset = DEFAULT_OFFSET,
    style,
    ...props
  },
  forwardedRef,
) {
  const normalizedDuration = Math.max(0, finiteOr(duration, DEFAULT_DURATION));
  const normalizedDelay = Math.max(0, finiteOr(delay, 0));
  const normalizedOffset = finiteOr(offset, DEFAULT_OFFSET);
  const normalizedBlur = blur.trim() || DEFAULT_BLUR;

  const initialVisible = React.useState(() => {
    // During SSR there is no viewport to observe. The client effect will reveal the element
    // immediately after hydration, while browser-side reduced-motion checks avoid a first-frame
    // flash for users who have disabled motion.
    if (typeof window === 'undefined') return false;
    if (prefersReducedMotion()) return true;
    return inView && !supportsIntersectionObserver();
  })[0];
  const [isVisible, setIsVisible] = React.useState(initialVisible);
  const hasPlayedRef = React.useRef(initialVisible);
  const nodeRef = React.useRef<HTMLElement | null>(null);

  const reveal = React.useCallback(() => {
    if (hasPlayedRef.current) return;
    hasPlayedRef.current = true;
    setIsVisible(true);
  }, []);

  const setNodeRef = React.useCallback(
    (node: HTMLElement | null) => {
      nodeRef.current = node;

      if (typeof forwardedRef === 'function') {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  React.useEffect(() => {
    if (prefersReducedMotion()) {
      reveal();
      return;
    }

    // An eager fade still runs when `inView` is false. There is no observer needed in that mode.
    if (!inView) {
      if (typeof window.requestAnimationFrame !== 'function') {
        reveal();
        return;
      }

      const frame = window.requestAnimationFrame(reveal);
      return () => window.cancelAnimationFrame(frame);
    }

    // If IntersectionObserver is unavailable, keeping content visible is safer than leaving a
    // component permanently hidden behind its initial animation state.
    if (!supportsIntersectionObserver()) {
      reveal();
      return;
    }

    const node = nodeRef.current;
    if (!node) {
      reveal();
      return;
    }

    let observer: IntersectionObserver;
    try {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting) {
            reveal();
            observer.disconnect();
          }
        },
        { rootMargin: inViewMargin },
      );
    } catch {
      // Invalid root margins and partial browser implementations should never hide content.
      reveal();
      return;
    }

    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, inViewMargin, reveal]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    let mediaQuery: MediaQueryList;
    try {
      mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }

    const handleChange = () => {
      if (mediaQuery.matches) reveal();
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [reveal]);

  const startTranslation = {
    up: { x: 0, y: normalizedOffset },
    down: { x: 0, y: -normalizedOffset },
    left: { x: normalizedOffset, y: 0 },
    right: { x: -normalizedOffset, y: 0 },
  }[direction];

  const animationStyle = {
    ...style,
    '--blur-fade-duration': `${normalizedDuration}s`,
    '--blur-fade-delay': `${normalizedDelay}s`,
    '--blur-fade-blur': normalizedBlur,
    '--blur-fade-start-x': `${startTranslation.x}px`,
    '--blur-fade-start-y': `${startTranslation.y}px`,
  } as React.CSSProperties;

  return (
    <Element
      // The callback accepts every element in `BlurFadeElement`; the JSX intrinsic union is
      // inferred from the default `div`, so keep the ref cast local to this polymorphic boundary.
      ref={setNodeRef as React.Ref<HTMLDivElement>}
      className={['blur-fade', className].filter(Boolean).join(' ')}
      data-blur-fade-state={isVisible ? 'visible' : 'hidden'}
      style={animationStyle}
      {...props}
    >
      {children}
    </Element>
  );
});

BlurFade.displayName = 'BlurFade';

export { BlurFade };
