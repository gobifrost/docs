export const MAX_RICH_IMAGE_BYTES = 5 * 1024 * 1024;

const SAFE_RICH_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function richImageError(file: File): string | null {
  if (!SAFE_RICH_IMAGE_TYPES.has(file.type.toLowerCase())) {
    return "Images must be PNG, JPEG, GIF, WebP, or AVIF files.";
  }
  if (file.size > MAX_RICH_IMAGE_BYTES) return "Images must be smaller than 5 MB.";
  return null;
}
