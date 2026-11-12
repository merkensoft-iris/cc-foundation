/**
 * The tray icon, drawn in code as a BGRA bitmap so the shell ships no image asset: a filled
 * disc, blue in normal mode and amber in developer mode (ADR 0004 decision 7). The engine's
 * own icon set replaces it when `@cc/build` packages the app (P1-16).
 */
export const TRAY_ICON_SIZE = 16;

const COLOURS = {
  normal: [0xd0, 0x6a, 0x1f], // BGR of #1f6ad0
  developer: [0x00, 0x8c, 0xd9], // BGR of #d98c00
} as const;

export function trayIconBitmap(variant: 'normal' | 'developer'): Buffer {
  const size = TRAY_ICON_SIZE;
  const [blue, green, red] = COLOURS[variant];
  const bitmap = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre);
      // A one-pixel soft edge.
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - distance));
      const offset = (y * size + x) * 4;
      // Premultiplied BGRA, as Electron's createFromBitmap expects on every platform.
      bitmap[offset] = Math.round(blue * alpha);
      bitmap[offset + 1] = Math.round(green * alpha);
      bitmap[offset + 2] = Math.round(red * alpha);
      bitmap[offset + 3] = Math.round(255 * alpha);
    }
  }
  return bitmap;
}
