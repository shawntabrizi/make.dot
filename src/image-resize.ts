// Client-side image downscaler. Used when a picked file exceeds the signer's
// per-transaction Bulletin authorization limit. We iterate: drop JPEG quality
// first (cheap, no perceptual loss until ~q=0.5), then shrink dimensions when
// quality alone can't get the file under the byte cap.
//
// JPEG-only output. Transparent PNG pixels are flattened onto white — fine for
// the screenshot/photo case that motivated this, and predictable. PNGs that
// happen to already fit the limit aren't resized (the upload-flow caller
// checks file.size first).

const MIN_QUALITY = 0.4;
const MIN_SCALE = 0.05;
const QUALITY_STEP = 0.1;
const SCALE_STEP = 0.8;

async function loadImage(file: File): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`Could not decode ${file.name}`));
            img.src = url;
        });
        return img;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("Canvas encode failed"))),
            "image/jpeg",
            quality,
        );
    });
}

export interface ResizeResult {
    bytes: Uint8Array;
    filename: string;
    originalBytes: number;
    finalBytes: number;
    scale: number;
    quality: number;
}

export async function resizeImageToFit(file: File, maxBytes: number): Promise<ResizeResult> {
    const img = await loadImage(file);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    let scale = 1;
    let quality = 0.92;

    while (true) {
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const blob = await canvasToJpegBlob(canvas, quality);
        if (blob.size <= maxBytes) {
            return {
                bytes: new Uint8Array(await blob.arrayBuffer()),
                filename: file.name.replace(/\.[^.]+$/, "") + ".jpg",
                originalBytes: file.size,
                finalBytes: blob.size,
                scale,
                quality,
            };
        }

        if (quality > MIN_QUALITY + 1e-6) {
            quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
            continue;
        }
        scale *= SCALE_STEP;
        quality = 0.85;
        if (scale < MIN_SCALE) {
            throw new Error(
                `Could not compress image under ${maxBytes.toLocaleString()} bytes ` +
                    `(stuck at scale ${(scale / SCALE_STEP).toFixed(2)}, ` +
                    `last size ${blob.size.toLocaleString()})`,
            );
        }
    }
}
