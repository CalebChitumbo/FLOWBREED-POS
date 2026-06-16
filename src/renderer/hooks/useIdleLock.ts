import { useEffect } from 'react';

/**
 * Locks the screen after `timeoutMs` of no user input (FU-05). Any mouse/keyboard/
 * touch activity resets the timer. The timeout is configurable (Settings, M8).
 */
export function useIdleLock(timeoutMs: number, onIdle: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = (): void => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, timeoutMs);
    };
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [timeoutMs, onIdle, enabled]);
}
