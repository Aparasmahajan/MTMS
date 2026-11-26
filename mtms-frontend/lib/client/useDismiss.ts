'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Closes a dropdown on Escape or on a click outside it.
 *
 * The project switcher and the inbox could only be closed by clicking their own button again:
 * no Escape, and a click anywhere else left them open over the page.
 */
export function useDismiss(ref: RefObject<HTMLElement>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    function onPointer(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    }

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [ref, open, close]);
}
