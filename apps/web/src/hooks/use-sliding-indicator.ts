import { useCallback, useLayoutEffect, useState, type CSSProperties } from 'react';

/** Measures variable-width controls without changing their native tab/button behavior. */
export function useSlidingIndicator(value: string, activeSelector: string) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const ref = useCallback((node: HTMLDivElement | null) => setContainer(node), []);

  useLayoutEffect(() => {
    if (!container) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const active = container.querySelector<HTMLElement>(activeSelector);
      if (!active) return;
      const bounds = active.getBoundingClientRect();
      const origin = container.getBoundingClientRect();
      const left = bounds.left - origin.left + container.scrollLeft - container.clientLeft;
      const width = bounds.width;
      setIndicator(previous => previous.left === left && previous.width === width
        ? previous : { left, width });
      // Scroll only the selector, leaving the settings drawer at its current position.
      const start = left - 8;
      const end = left + width + 8;
      if (start < container.scrollLeft) container.scrollLeft = Math.max(0, start);
      else if (end > container.scrollLeft + container.clientWidth) {
        container.scrollLeft = end - container.clientWidth;
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    container.querySelectorAll<HTMLElement>('button').forEach(button => observer.observe(button));
    void document.fonts.ready.then(measure);
    return () => { disposed = true; observer.disconnect(); };
  }, [container, value, activeSelector]);

  const style = {
    '--selector-left': `${indicator.left}px`,
    '--selector-width': `${indicator.width}px`,
    '--selector-ready': indicator.width > 0 ? 1 : 0,
  } as CSSProperties;
  return { ref, style };
}
