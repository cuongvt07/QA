/**
 * Locator Utility
 * Uses OpenCV template matching to find exact coordinates of an option thumbnail in the preview.
 * Falls back to diffMask if OpenCV is not available.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ssdMatcher = require('./ssd-matcher');

const thumbnailCache = new Map();

function clearThumbnailCache() {
    thumbnailCache.clear();
}

/**
 * Builds a map of characters from timeline steps where the visual change (diffMask)
 * indicates the exact pixel location of the entire character (e.g. Skin, Body steps).
 */
function buildCharacterMapFromTimeline(timelineSteps) {
    const anchorSteps = timelineSteps.filter(s => {
        const name = (s.name || '').toLowerCase();
        const isSkinOrBody = name.includes('skin') || name.includes('body');
        const isLargeDiff = s.diff_score > 3.0 && s.group_type === 'image_option';
        const hasValidMask = s.diffMask?.w > 30 && s.diffMask?.w < 400; // sensible character sizes
        return (isSkinOrBody || isLargeDiff) && hasValidMask;
    });

    return anchorSteps
        .map(s => ({
            stepId: s.step_id,
            bbox: s.diffMask,
            centerX: s.diffMask.x + (s.diffMask.w / 2),
        }))
        .sort((a, b) => a.centerX - b.centerX) // Trái -> phải (Left -> Right)
        .map((z, i) => ({ ...z, characterIndex: i }));
}

/**
 * Detect which "character section" this step belongs to based on timeline patterns.
 */
function detectCharacterContext(timelineSteps, currentStep) {
    if (!timelineSteps?.length) {
        return { characterIndex: 0, totalCharacters: 1, strategy: 'default' };
    }

    // Priority 1: Explicit number in step name (e.g., "Cat Breed 3" -> index 2)
    const numMatch = (currentStep?.name || '').match(/(\d+)\s*$/);
    if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        return {
            characterIndex: Math.max(0, idx),
            totalCharacters: Math.max(idx + 1, 2),
            strategy: 'explicit_number',
        };
    }

    // Priority 2: Character map from skin/large-diff steps (exact pixel zones)
    const charMap = buildCharacterMapFromTimeline(timelineSteps);
    if (charMap.length > 1) {
        // Find the most recent anchor step zone before the current step
        const precedingSteps = timelineSteps
            .filter(s => s.step_id < currentStep.step_id)
            .reverse();

        for (const prev of precedingSteps) {
            const zone = charMap.find(z => z.stepId === prev.step_id);
            if (zone) {
                return {
                    characterIndex: zone.characterIndex,
                    totalCharacters: charMap.length,
                    bbox: zone.bbox, // Tọa độ thật - exact coordinate
                    strategy: 'skin_delta_map',
                };
            }
        }
    }

    // Priority 3: Normalize step name and count repetitions
    const normalize = (name) => name
        .toLowerCase()
        .replace(/['`]/g, '')
        .replace(/\b\w+('s)?\b/gi, w => w.endsWith("'s") ? '' : w) // Remove possessives
        .replace(/\d+/g, '') // Remove numbers
        .replace(/\s+/g, ' ')
        .trim();

    const currentNorm = normalize(currentStep?.name || '');
    const repeatCount = timelineSteps.filter(s =>
        s.step_id < currentStep.step_id &&
        normalize(s.name || '') === currentNorm
    ).length;

    return {
        characterIndex: repeatCount,
        totalCharacters: repeatCount + 1,
        strategy: 'pattern_repeat',
    };
}

/**
 * Get the search zone for a specific character on the canvas.
 * Divides the canvas into N vertical strips, clamped to avoid out of bounds.
 */
function getCharacterSearchZone(characterIndex, totalCharacters, canvasW, canvasH) {
    if (totalCharacters <= 1) return null;

    // Clamp index to avoid out of bounds
    const safeIndex = Math.min(characterIndex, totalCharacters - 1);

    const stripW = Math.round(canvasW / totalCharacters);
    const overlap = Math.round(stripW * 0.08); // 8% overlap

    const x = Math.max(0, safeIndex * stripW - overlap);
    const w = Math.min(canvasW - x, stripW + overlap * 2);

    // Guard: Zone must be large enough to be meaningful
    if (w < 50) return null; // Fallback to full canvas

    return { x, y: 0, w, h: canvasH };
}

/**
 * Get a sub-region within a character zone based on customization type.
 */
function getSubRegion(stepName, characterBbox) {
    if (!characterBbox || characterBbox.w === 0) return null;

    const name = (stepName || '').toLowerCase();

    if (name.includes('hair') && !name.includes('beard')) {
        return {
            x: characterBbox.x,
            y: characterBbox.y,
            w: characterBbox.w,
            h: Math.round(characterBbox.h * 0.35)
        };
    }
    if (name.includes('beard') || name.includes('mustache')) {
        return {
            x: characterBbox.x,
            y: characterBbox.y + Math.round(characterBbox.h * 0.20),
            w: characterBbox.w,
            h: Math.round(characterBbox.h * 0.25)
        };
    }
    if (name.includes('skin') || name.includes('face')) {
        return {
            x: characterBbox.x + Math.round(characterBbox.w * 0.15),
            y: characterBbox.y + Math.round(characterBbox.h * 0.08),
            w: Math.round(characterBbox.w * 0.70),
            h: Math.round(characterBbox.h * 0.40)
        };
    }

    return characterBbox;
}

/**
 * Determines min, max scaling ratios.
 */
function getScaleRange(diffMask, templateSize, canvasSize) {
    if (diffMask && diffMask.w > 0 && diffMask.w < canvasSize.w * 0.8) {
        const estimatedScale = (diffMask.w * 0.7) / templateSize.w;
        const margin = 0.3;
        return {
            min: Math.max(0.2, estimatedScale - margin), // Lowered min limit from 0.4 to 0.2
            max: Math.min(1.5, estimatedScale + margin),
            step: 0.1,
        };
    }
    return { min: 0.2, max: 1.2, step: 0.15 };
}

/**
 * Validates template match candidate based on color correlation.
 */
async function colorSecondaryCheck(opencv, previewMat, templateMat, candidate) {
    // Guard: ignore if too small (histogram wouldn't be reliable) -> neutral
    if (candidate.w < 20 || candidate.h < 20) return 0.5;

    try {
        // Clamp bounds to prevent crashing when candidate is off frame
        const safeW = Math.min(candidate.w, previewMat.cols - candidate.x);
        const safeH = Math.min(candidate.h, previewMat.rows - candidate.y);
        if (safeW < 10 || safeH < 10) return 0.5;

        const candidateZone = previewMat.getRegion(
            new opencv.Rect(candidate.x, candidate.y, safeW, safeH)
        );

        const previewHSV = candidateZone.cvtColor(opencv.COLOR_BGR2HSV);
        const templateHSV = templateMat
            .resize(safeH, safeW) // (height, width) OpenCV standard
            .cvtColor(opencv.COLOR_BGR2HSV);

        const previewHist = previewHSV.splitChannels()[0].calcHist([180], [0, 180]);
        const templateHist = templateHSV.splitChannels()[0].calcHist([180], [0, 180]);

        return opencv.compareHist(previewHist, templateHist, opencv.HISTCMP_CORREL);
    } catch (e) {
        return 0.5; // neutral instead of 0 to avoid punishing good matches on error
    }
}

/**
 * Locate the given thumbnail graphic in the full preview image constraints.
 */
async function locateOptionInPreview(optionThumbnailUrl, previewPath, diffMask = null, stepContext = null) {
    let opencv = null;
    try { opencv = require('opencv4nodejs'); } catch (e) { /* Silent fallback to SSD */ }

    if (!optionThumbnailUrl) return diffMask;

    let characterZone = null;
    let exactBbox = null;

    if (stepContext?.timelineSteps && stepContext?.currentStep) {
        const result = detectCharacterContext(
            stepContext.timelineSteps,
            stepContext.currentStep
        );

        console.log(`    [LOCATOR] Context: index=${result.characterIndex}/${result.totalCharacters} strategy=${result.strategy} step="${stepContext.currentStep.name}"`);

        // If exact bbox found through skin delta, use it.
        if (result.bbox) {
            exactBbox = getSubRegion(stepContext.currentStep.name, result.bbox);
        }

        if (result.totalCharacters > 1 && !exactBbox) {
            const sharp = require('sharp');
            try {
                const meta = await sharp(previewPath).metadata();
                characterZone = getCharacterSearchZone(
                    result.characterIndex,
                    result.totalCharacters,
                    meta.width,
                    meta.height
                );
                if (characterZone) {
                    characterZone = getSubRegion(stepContext.currentStep.name, characterZone);
                }
            } catch (e) {
                /* ignore */
            }
        }
    }

    try {
        let templateBuffer;
        if (thumbnailCache.has(optionThumbnailUrl)) {
            templateBuffer = thumbnailCache.get(optionThumbnailUrl);
        } else {
            const response = await axios.get(optionThumbnailUrl, {
                responseType: 'arraybuffer',
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            templateBuffer = Buffer.from(response.data);
            thumbnailCache.set(optionThumbnailUrl, templateBuffer);
        }

        // 1. OpenCV matching
        if (opencv) {
            try {
                const preview = opencv.imread(previewPath);
                const template = opencv.imdecode(templateBuffer);
                const canvasSize = { w: preview.cols, h: preview.rows };
                const templateSize = { w: template.cols, h: template.rows };

                let searchRegion = null;
                let offsetX = 0, offsetY = 0;

                // Priority: exactBbox > characterZone > diffMask
                const searchZone = exactBbox || characterZone ||
                    (diffMask?.w > 0 && diffMask.w < canvasSize.w * 0.9 ? diffMask : null);

                if (searchZone) {
                    const cx = Math.max(0, Math.min(searchZone.x, canvasSize.w - 1));
                    const cy = Math.max(0, Math.min(searchZone.y, canvasSize.h - 1));
                    const cw = Math.min(searchZone.w, canvasSize.w - cx);
                    const ch = Math.min(searchZone.h, canvasSize.h - cy);

                    if (cw > templateSize.w && ch > templateSize.h) {
                        searchRegion = preview.getRegion(new opencv.Rect(cx, cy, cw, ch));
                        offsetX = cx;
                        offsetY = cy;
                    }
                }

                const searchArea = searchRegion || preview;
                const previewEdge = searchArea.bgrToGray().canny(30, 100);
                const scaleRange = getScaleRange(diffMask, templateSize, canvasSize);

                let bestMatch = null;
                for (let scale = scaleRange.min; scale <= scaleRange.max; scale += scaleRange.step) {
                    const tw = Math.round(template.cols * scale);
                    const th = Math.round(template.rows * scale);
                    if (th < 20 || tw < 20) continue;

                    const resized = template.resize(th, tw);
                    const templateEdge = resized.bgrToGray().canny(30, 100);
                    const matched = previewEdge.matchTemplate(templateEdge, opencv.TM_CCOEFF_NORMED);
                    const { maxVal, maxLoc } = matched.minMaxLoc();

                    if (!bestMatch || maxVal > bestMatch.score) {
                        bestMatch = { score: maxVal, x: maxLoc.x, y: maxLoc.y, w: tw, h: th };
                    }
                }

                if (bestMatch?.score >= 0.45) {
                    if (bestMatch.score < 0.6) {
                        const colorCorr = await colorSecondaryCheck(opencv, searchArea, template, bestMatch);
                        if (colorCorr < 0.3) {
                            console.warn(`    [LOCATOR] Candidate rejected by color correlation: ${colorCorr.toFixed(2)}`);
                            bestMatch = null;
                        }
                    }
                }

                if (bestMatch?.score >= 0.45) {
                    console.log(`    [LOCATOR] OpenCV match: score=${bestMatch.score.toFixed(2)} scale=${(bestMatch.w / template.cols).toFixed(1)} source=${exactBbox ? 'exactBbox' : characterZone ? 'charZone' : diffMask ? 'diffMask' : 'fullCanvas'}`);
                    const pad = 10;
                    return {
                        x: Math.max(0, bestMatch.x + offsetX - pad),
                        y: Math.max(0, bestMatch.y + offsetY - pad),
                        w: Math.min(canvasSize.w, bestMatch.w + pad * 2),
                        h: Math.min(canvasSize.h, bestMatch.h + pad * 2),
                        confidence: bestMatch.score,
                        source: 'opencv',
                    };
                }
            } catch (cvError) {
                console.warn(`    [LOCATOR] OpenCV search error: ${cvError.message}`);
            }
        }

        // 2. JS SSD Fallback
        const ssdZone = exactBbox || characterZone || diffMask;
        if (ssdZone?.w > 0) {
            const ssdResult = await ssdMatcher.ssdMatch(previewPath, templateBuffer, ssdZone);
            if (ssdResult) {
                console.log(`    [LOCATOR] SSD match: score=${ssdResult.confidence?.toFixed(2)}`);
                return ssdResult;
            }
        }

    } catch (err) {
        console.warn(`    [LOCATOR] General error: ${err.message}`);
    }

    // 3. Last fallback to characterZone or raw diffMask
    const fallback = exactBbox || characterZone || (diffMask?.w > 0 ? diffMask : null);
    if (fallback) {
        const sourceName = exactBbox ? 'exact_bbox' : characterZone ? 'character_zone' : 'diffmask';
        console.log(`    [LOCATOR] Fallback to: ${sourceName} confidence=${exactBbox ? 0.7 : 0.5}`);
        return {
            ...fallback,
            source: sourceName,
            confidence: exactBbox ? 0.7 : 0.5,
        };
    }

    return null;
}

module.exports = {
    locateOptionInPreview,
    buildCharacterMapFromTimeline,
    detectCharacterContext,
    clearThumbnailCache,
};
