/** Integer layout-pixel rectangle, or null while a numeric field is incomplete. */
export function cropRect(rect) {
  if (!rect || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(rect[k]))) return null;
  const result = Object.fromEntries(['x', 'y', 'w', 'h'].map(k => [k, Math.round(rect[k])]));
  return result.w > 0 && result.h > 0 ? result : null;
}

export function viewport(bounds, crop) {
  return (crop?.enabled && cropRect(crop.rect)) || { ...bounds };
}

/** Browser pointer -> layout coordinates, including a cropped origin and CSS zoom. */
export function layoutPoint(clientX, clientY, canvasRect, view) {
  return [view.x + (clientX - canvasRect.left) * view.w / canvasRect.width,
    view.y + (clientY - canvasRect.top) * view.h / canvasRect.height];
}

/** A drag may go in either direction; restrict pointer selection to the shown view. */
export function selectedCrop(start, end, view) {
  const clamp = ([x, y]) => [Math.max(view.x, Math.min(view.x + view.w, x)),
    Math.max(view.y, Math.min(view.y + view.h, y))];
  const a = clamp(start), b = clamp(end);
  if (a[0] === b[0] || a[1] === b[1]) return null;
  const x = Math.floor(Math.min(a[0], b[0])), y = Math.floor(Math.min(a[1], b[1]));
  return { x, y, w: Math.ceil(Math.max(a[0], b[0])) - x, h: Math.ceil(Math.max(a[1], b[1])) - y };
}
