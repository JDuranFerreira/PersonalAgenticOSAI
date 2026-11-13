/* ==========================================================================
   Agentic OS — ResizeHandle
   Drag a panel's edge to resize it. Hover the boundary to reveal the handle,
   drag to adjust, double-click to reset. Width persists in localStorage
   (via the useResizableWidth hook in src/utils/).
   ========================================================================== */

export default function ResizeHandle({ side, onDragStart, onReset }) {
  return (
    <div
      className={`resize-handle ${side}`}
      onPointerDown={onDragStart}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset"
      role="separator"
      aria-orientation="vertical"
    />
  );
}
