/**
 * Natural-size dimensions of an image file, read entirely client-side
 * without ever uploading it - used both by the manual floor-plan underlay
 * upload (`FloorPlanPanel` in components/studio/Inspector.tsx, issue #52) to
 * work out its real-world height once the operator gives a width, and by the
 * one-click "Auto-populate from floor plan" upload (`ProjectWorkbench.tsx`,
 * issue #58) to send the server the aspect ratio it needs without a
 * server-side image decoder.
 */
export function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image dimensions'));
    };
    img.src = url;
  });
}
