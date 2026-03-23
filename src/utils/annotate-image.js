const fs = require('fs');
const { PNG } = require('pngjs');
const sharp = require('sharp');

/**
 * Draws multiple bounding boxes on a PNG image based on normalized coordinates (0-1000) and specific colors.
 * 
 * @param {string} inputPath - Path to the original PNG image.
 * @param {string} outputPath - Path to save the annotated PNG image.
 * @param {Array<{bbox: number[], color: {r: number, g: number, b: number}}>} annotations 
 * @returns {Promise<boolean>} Resolves to true if successful, false otherwise.
 */
function drawMultipleBoundingBoxes(inputPath, outputPath, annotations) {
    return new Promise(async (resolve) => {
        if (!annotations || annotations.length === 0) {
            return resolve(false);
        }

        try {
            // Guarantee pure PNG header so pngjs doesn't crash on invalid signatures
            const pngBuffer = await sharp(inputPath).png().toBuffer();

            new PNG({ filterType: 4 }).parse(pngBuffer, (err, parsedPng) => {
                if (err || !parsedPng || !parsedPng.data) {
                    console.warn('    ⚠️ Error parsing image for annotation:', err?.message || 'Invalid PNG data');
                    return resolve(false);
                }

                try {
                    const png = parsedPng;
                    const width = png.width;
                    const height = png.height;
                    const thickness = 4; // Thickness of the box 

                    for (const ann of annotations) {
                        if (!ann.bbox || ann.bbox.length !== 4) continue;
                        
                        const { r, g, b } = ann.color || { r: 255, g: 0, b: 0 };
                        const [nx1, ny1, nx2, ny2] = ann.bbox;

                        // Denormalize points
                        const x1 = Math.round((nx1 / 1000) * width);
                        const y1 = Math.round((ny1 / 1000) * height);
                        const x2 = Math.round((nx2 / 1000) * width);
                        const y2 = Math.round((ny2 / 1000) * height);

                        // Draw horizontal lines
                        for (let x = Math.max(0, x1); x <= Math.min(width - 1, x2); x++) {
                            for (let t = 0; t < thickness; t++) {
                                // Top line
                                if (y1 + t >= 0 && y1 + t < height) setPixel(png, x, y1 + t, r, g, b, 255);
                                // Bottom line
                                if (y2 - t >= 0 && y2 - t < height) setPixel(png, x, y2 - t, r, g, b, 255);
                            }
                        }

                        // Draw vertical lines
                        for (let y = Math.max(0, y1); y <= Math.min(height - 1, y2); y++) {
                            for (let t = 0; t < thickness; t++) {
                                // Left line
                                if (x1 + t >= 0 && x1 + t < width) setPixel(png, x1 + t, y, r, g, b, 255);
                                // Right line
                                if (x2 - t >= 0 && x2 - t < width) setPixel(png, x2 - t, y, r, g, b, 255);
                            }
                        }

                        // Add a slightly translucent background inside
                        for (let y = Math.max(0, y1 + thickness); y <= Math.min(height - 1, y2 - thickness); y++) {
                            for (let x = Math.max(0, x1 + thickness); x <= Math.min(width - 1, x2 - thickness); x++) {
                                blendPixel(png, x, y, r, g, b, 40); // 40 alpha over 255
                            }
                        }
                    }

                    const out = fs.createWriteStream(outputPath);
                    out.on('finish', () => resolve(true));
                    out.on('error', (e) => {
                        console.warn('    ⚠️ Error saving annotated image:', e.message);
                        resolve(false);
                    });
                    png.pack().pipe(out);
                } catch (drawErr) {
                    console.warn('    ⚠️ Error drawing annotation:', drawErr.message);
                    resolve(false);
                }
            });
        } catch (err) {
            console.warn('    ⚠️ Error preparing original image for annotation:', err.message);
            resolve(false);
        }
    });
}

function setPixel(png, x, y, r, g, b, a) {
    const idx = (png.width * y + x) << 2;
    png.data[idx] = r;
    png.data[idx + 1] = g;
    png.data[idx + 2] = b;
    png.data[idx + 3] = a;
}

function blendPixel(png, x, y, r, g, b, a) {
    const idx = (png.width * y + x) << 2;
    const alphaSrc = a / 255;
    const alphaDst = png.data[idx + 3] / 255;
    
    // Simple alpha blending
    png.data[idx] = Math.round((r * alphaSrc) + (png.data[idx] * (1 - alphaSrc)));
    png.data[idx + 1] = Math.round((g * alphaSrc) + (png.data[idx + 1] * (1 - alphaSrc)));
    png.data[idx + 2] = Math.round((b * alphaSrc) + (png.data[idx + 2] * (1 - alphaSrc)));
    // Keep original alpha mostly
    png.data[idx + 3] = Math.max(png.data[idx + 3], a); 
}

module.exports = {
    drawMultipleBoundingBoxes
};
