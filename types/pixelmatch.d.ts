/**
 * Minimal typings for pixelmatch 5.x, which ships without declarations.
 *
 * Lens only uses the documented buffer-in/buffer-out path, so this stays small
 * rather than mirroring the whole upstream surface.
 */
declare module 'pixelmatch' {
  export interface PixelmatchOptions {
    threshold?: number;
    includeAA?: boolean;
    alpha?: number;
    aaColor?: [number, number, number];
    diffColor?: [number, number, number];
    diffColorAlt?: [number, number, number];
    diffMask?: boolean;
  }

  export default function pixelmatch(
    img1: ArrayLike<number>,
    img2: ArrayLike<number>,
    output: ArrayLike<number> | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
