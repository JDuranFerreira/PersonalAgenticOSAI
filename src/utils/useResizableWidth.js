/* ==========================================================================
   Agentic OS — useResizableWidth hook
   Persisted, clamped panel width driven by dragging a resize handle.
   ========================================================================== */
import { useState, useRef, useCallback, useEffect } from "react";

/**
 * @param {object} opts
 * @param {string} opts.storageKey  localStorage key for the width
 * @param {number} opts.defaultValue
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {"left"|"right"} [opts.side]  which edge the handle sits on:
 *   "left"  = panel is on the right, drag left to widen
 *   "right" = panel is on the left, drag right to widen
 */
export function useResizableWidth({ storageKey, defaultValue, min, max, side = "left" }) {
  const clamp = useCallback((v) => Math.min(max, Math.max(min, v)), [min, max]);

  const [width, setWidth] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem(storageKey));
      if (!Number.isNaN(v)) return Math.min(max, Math.max(min, v));
    } catch { /* storage unavailable */ }
    return defaultValue;
  });

  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  const startDrag = useCallback(
    (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;

      const onMove = (ev) => {
        const delta = side === "left" ? startX - ev.clientX : ev.clientX - startX;
        setWidth(clamp(startWidth + delta));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.classList.remove("resizing");
        try { localStorage.setItem(storageKey, String(widthRef.current)); } catch { /* ignore */ }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      document.body.classList.add("resizing");
    },
    [side, clamp, storageKey]
  );

  const reset = useCallback(() => {
    setWidth(defaultValue);
    try { localStorage.setItem(storageKey, String(defaultValue)); } catch { /* ignore */ }
  }, [defaultValue, storageKey]);

  // Keyboard resize: nudge by a pixel delta and persist
  const nudge = useCallback(
    (delta) => {
      const next = clamp(widthRef.current + delta);
      setWidth(next);
      try { localStorage.setItem(storageKey, String(next)); } catch { /* ignore */ }
    },
    [clamp, storageKey]
  );

  return { width, startDrag, reset, nudge };
}
