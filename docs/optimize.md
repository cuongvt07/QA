# Locator.js — Phân tích & Tối ưu Toàn diện

---

## 1. Kiến trúc hiện tại

```
locateOptionInPreview()
        │
        ├── detectCharacterContext()     ← xác định nhân vật thứ mấy
        │       ├── Strategy 1: số cuối tên ("Cat 3" → index 2)
        │       ├── Strategy 2: keyword matching (man/woman/cat/dog...)
        │       └── Strategy 3: normalize + count pattern repeat
        │
        ├── getCharacterSearchZone()     ← chia canvas N strips
        │
        ├── getSubRegion()               ← thu hẹp vùng theo loại (hair/beard/skin)
        │
        ├── OpenCV template match        ← primary
        │       ├── Adaptive scale range
        │       ├── Canny edge detection
        │       └── HSV color secondary check
        │
        ├── JS-SSD fallback              ← khi không có OpenCV
        │
        └── characterZone / diffMask     ← last resort
```

---

## 2. Đánh giá từng phần

### 2.1 detectCharacterContext — Vấn đề cốt lõi

**Strategy 2 (keyword-based) là điểm yếu nhất toàn bộ file.**

```
Vấn đề:
  "Scottish Fold"  → không match keyword nào
  "Value 57"       → không match keyword nào
  "Sphynx Cat 2"   → match "cat" nhưng "cat" cũng có trong
                     "cat breed", "cat name", "cat style"...
  Product mới:     "Dragon", "Unicorn", "Robot" → miss hoàn toàn

Keyword list sẽ không bao giờ đủ với POD —
sản phẩm mới ra mỗi ngày, không thể maintain list cứng.
```

**groupTypeSequence được build nhưng không dùng** — dead code:
```javascript
const groupTypeSequence = timelineSteps  // ← build xong
    .filter(...)
    .map(s => s.name?.toLowerCase() || '');
// ← không được reference ở đâu sau đó
```

### 2.2 getCharacterSearchZone — Bug out-of-bounds

```javascript
// Nếu characterIndex = 2, totalCharacters = 2:
// stripW * 2 = canvasW → x bắt đầu ở edge → w = 0 hoặc âm
// Không có guard → crash hoặc search zone vô nghĩa
```

### 2.3 getSubRegion — Thiếu null guard

```javascript
// characterBbox có thể null nếu caller truyền sai
// function sẽ crash tại characterBbox.x
```

### 2.4 Scale range — min 0.4 quá cao

```javascript
// Step "Brown Beard" diff=0.28% → diffMask rất nhỏ
// estimatedScale = (small_w * 0.7) / template.w → có thể < 0.4
// Clamp min=0.4 → bỏ sót scale đúng
// Nên: min = Math.max(0.2, estimatedScale - margin)
```

### 2.5 colorSecondaryCheck — 2 bug nhỏ

```javascript
// Bug 1: candidate quá nhỏ → histogram không đáng tin
// candidate.w = 15px → calcHist trên 15px không meaningful

// Bug 2: catch trả về 0 → reject match tốt
// Nên trả 0.5 (neutral) thay vì 0 (reject)
```

### 2.6 axios — Không có timeout

```javascript
// CDN chậm → block cả case không có cap
await axios.get(optionThumbnailUrl, { responseType: 'arraybuffer' });
// Thiếu: timeout: 5000
```

### 2.7 Thiếu logging khi success

```javascript
// Hiện tại chỉ log khi fail (console.warn)
// Không biết locator đang dùng strategy nào, scale nào, zone nào
// → Không thể debug khi bbox sai
```

---

## 3. Giải pháp — Bỏ keyword, dùng structure

### 3.1 detectCharacterContext — Rewrite không cần keyword

Không cần biết "man/woman/cat/dragon" — chỉ cần nhìn **cấu trúc timeline**.

```javascript
function detectCharacterContext(timelineSteps, currentStep) {
    if (!timelineSteps?.length) {
        return { characterIndex: 0, totalCharacters: 1 };
    }

    // Priority 1: Số cuối tên — "Cat Breed 3" → index 2
    // Reliable nhất khi Customily đặt tên đúng convention
    const numMatch = (currentStep?.name || '').match(/(\d+)\s*$/);
    if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1;
        return {
            characterIndex:  Math.max(0, idx),
            totalCharacters: Math.max(idx + 1, 2),
            strategy:        'explicit_number',
        };
    }

    // Priority 2: Character map từ skin/large-diff steps
    // Không cần keyword — dùng vị trí pixel thật từ diffMask
    const charMap = buildCharacterMapFromTimeline(timelineSteps);
    if (charMap.length > 1) {
        // Tìm character zone gần nhất trước step hiện tại
        const precedingSteps = timelineSteps
            .filter(s => s.step_id < currentStep.step_id)
            .reverse();

        for (const prev of precedingSteps) {
            const zone = charMap.find(z => z.stepId === prev.step_id);
            if (zone) {
                return {
                    characterIndex:  zone.characterIndex,
                    totalCharacters: charMap.length,
                    bbox:            zone.bbox, // tọa độ thật
                    strategy:        'skin_delta_map',
                };
            }
        }
    }

    // Priority 3: Normalize pattern repeat — không cần keyword
    // "Choose Man's Hair Color" và "Choose Woman's Hair Color"
    // đều normalize thành "choose hair color"
    // → đếm lần lặp = biết đây là nhân vật thứ mấy
    const normalize = (name) => name
        .toLowerCase()
        .replace(/[''`]/g, '')
        .replace(/\b\w+('s)?\b/gi, w => w.endsWith("'s") ? '' : w) // bỏ possessives
        .replace(/\d+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const currentNorm = normalize(currentStep?.name || '');
    const repeatCount = timelineSteps.filter(s =>
        s.step_id < currentStep.step_id &&
        normalize(s.name || '') === currentNorm
    ).length;

    return {
        characterIndex:  repeatCount,
        totalCharacters: repeatCount + 1,
        strategy:        'pattern_repeat',
    };
}
```

### 3.2 buildCharacterMapFromTimeline — Detect vị trí pixel thật

```javascript
function buildCharacterMapFromTimeline(timelineSteps) {
    // Skin color / body steps thay đổi toàn bộ nhân vật
    // → diffMask của chúng = vị trí thật của từng nhân vật trên canvas
    const anchorSteps = timelineSteps.filter(s => {
        const name = (s.name || '').toLowerCase();
        const isSkinOrBody = name.includes('skin') || name.includes('body');
        const isLargeDiff  = s.diff_score > 3.0 && s.group_type === 'image_option';
        const hasValidMask = s.diffMask?.w > 30 && s.diffMask?.w < 400;
        return (isSkinOrBody || isLargeDiff) && hasValidMask;
    });

    return anchorSteps
        .map(s => ({
            stepId:  s.step_id,
            bbox:    s.diffMask,
            centerX: s.diffMask.x + s.diffMask.w / 2,
        }))
        .sort((a, b) => a.centerX - b.centerX) // trái → phải
        .map((z, i) => ({ ...z, characterIndex: i }));

    // Với 4 con mèo, kết quả:
    // [
    //   { characterIndex:0, centerX:80,  bbox:{x:40,y:100,w:80,h:120} },
    //   { characterIndex:1, centerX:220, bbox:{x:180,y:100,w:80,h:120} },
    //   { characterIndex:2, centerX:360, bbox:{x:320,y:100,w:80,h:120} },
    //   { characterIndex:3, centerX:500, bbox:{x:460,y:100,w:80,h:120} },
    // ]
}
```

### 3.3 getCharacterSearchZone — Fix out-of-bounds

```javascript
function getCharacterSearchZone(characterIndex, totalCharacters, canvasW, canvasH) {
    if (totalCharacters <= 1) return null;

    // Clamp index để tránh out of bounds
    const safeIndex = Math.min(characterIndex, totalCharacters - 1);

    const stripW  = Math.round(canvasW / totalCharacters);
    const overlap = Math.round(stripW * 0.08); // 8% overlap cho boundary cases

    const x = Math.max(0, safeIndex * stripW - overlap);
    const w = Math.min(canvasW - x, stripW + overlap * 2);

    // Guard: zone phải đủ lớn để search có ý nghĩa
    if (w < 50) return null; // quá hẹp → fallback full canvas

    return { x, y: 0, w, h: canvasH };
}
```

### 3.4 getSubRegion — Thêm null guard

```javascript
function getSubRegion(stepName, characterBbox) {
    if (!characterBbox || characterBbox.w === 0) return null;

    const name = (stepName || '').toLowerCase();

    if (name.includes('hair') && !name.includes('beard')) {
        return {
            x: characterBbox.x,
            y: characterBbox.y,
            w: characterBbox.w,
            h: Math.round(characterBbox.h * 0.35),
        };
    }
    if (name.includes('beard') || name.includes('mustache')) {
        return {
            x: characterBbox.x,
            y: characterBbox.y + Math.round(characterBbox.h * 0.20),
            w: characterBbox.w,
            h: Math.round(characterBbox.h * 0.25),
        };
    }
    if (name.includes('skin') || name.includes('face')) {
        return {
            x: characterBbox.x + Math.round(characterBbox.w * 0.15),
            y: characterBbox.y + Math.round(characterBbox.h * 0.08),
            w: Math.round(characterBbox.w * 0.70),
            h: Math.round(characterBbox.h * 0.40),
        };
    }

    return characterBbox;
}
```

### 3.5 Scale range — Hạ min xuống 0.2

```javascript
function getScaleRange(diffMask, templateSize, canvasSize) {
    if (diffMask && diffMask.w > 0 && diffMask.w < canvasSize.w * 0.8) {
        const estimatedScale = (diffMask.w * 0.7) / templateSize.w;
        const margin = 0.3;
        return {
            min:  Math.max(0.2, estimatedScale - margin), // 0.4 → 0.2
            max:  Math.min(1.5, estimatedScale + margin),
            step: 0.1,
        };
    }
    return { min: 0.2, max: 1.2, step: 0.15 };
}
```

### 3.6 colorSecondaryCheck — Fix 2 bug

```javascript
async function colorSecondaryCheck(opencv, previewMat, templateMat, candidate) {
    // Guard: quá nhỏ → histogram không đáng tin → neutral
    if (candidate.w < 20 || candidate.h < 20) return 0.5;

    try {
        // Clamp để không ra ngoài previewMat
        const safeW = Math.min(candidate.w, previewMat.cols - candidate.x);
        const safeH = Math.min(candidate.h, previewMat.rows - candidate.y);
        if (safeW < 10 || safeH < 10) return 0.5;

        const candidateZone = previewMat.getRegion(
            new opencv.Rect(candidate.x, candidate.y, safeW, safeH)
        );

        const previewHSV  = candidateZone.cvtColor(opencv.COLOR_BGR2HSV);
        const templateHSV = templateMat
            .resize(safeH, safeW) // (height, width) — đúng thứ tự opencv4nodejs
            .cvtColor(opencv.COLOR_BGR2HSV);

        const previewHist  = previewHSV.splitChannels()[0].calcHist([180], [0, 180]);
        const templateHist = templateHSV.splitChannels()[0].calcHist([180], [0, 180]);

        return opencv.compareHist(previewHist, templateHist, opencv.HISTCMP_CORREL);
    } catch (e) {
        return 0.5; // neutral thay vì 0 — không reject match tốt vì error
    }
}
```

### 3.7 axios — Thêm timeout

```javascript
const response = await axios.get(optionThumbnailUrl, {
    responseType: 'arraybuffer',
    timeout:      5000,
    headers:      { 'User-Agent': 'Mozilla/5.0' },
});
```

### 3.8 Logging đầy đủ

```javascript
// Log character context để verify
console.log(`    [LOCATOR] Context: index=${characterIndex}/${totalCharacters} strategy=${result.strategy} step="${currentStep.name}"`);

// Log khi find được match
console.log(`    [LOCATOR] OpenCV match: score=${bestMatch.score.toFixed(2)} scale=${scale.toFixed(1)} source=${characterZone ? 'charZone' : diffMask ? 'diffMask' : 'fullCanvas'}`);

// Log fallback
console.log(`    [LOCATOR] Fallback to: ${result.source} confidence=${result.confidence}`);
```

---

## 4. locateOptionInPreview — Flow cập nhật

```javascript
async function locateOptionInPreview(optionThumbnailUrl, previewPath, diffMask = null, stepContext = null) {
    let opencv = null;
    try { opencv = require('opencv4nodejs'); } catch {}

    if (!optionThumbnailUrl) return diffMask;

    // Xác định search zone
    let characterZone = null;
    let exactBbox     = null; // từ skin_delta_map — chính xác nhất

    if (stepContext?.timelineSteps && stepContext?.currentStep) {
        const result = detectCharacterContext(
            stepContext.timelineSteps,
            stepContext.currentStep
        );

        console.log(`    [LOCATOR] Context: index=${result.characterIndex}/${result.totalCharacters} strategy=${result.strategy}`);

        // Nếu có bbox thật từ skin_delta_map → dùng luôn
        if (result.bbox) {
            exactBbox = getSubRegion(stepContext.currentStep.name, result.bbox);
        }

        if (result.totalCharacters > 1 && !exactBbox) {
            const sharp = require('sharp');
            try {
                const meta  = await sharp(previewPath).metadata();
                characterZone = getCharacterSearchZone(
                    result.characterIndex,
                    result.totalCharacters,
                    meta.width,
                    meta.height
                );
                if (characterZone) {
                    characterZone = getSubRegion(stepContext.currentStep.name, characterZone);
                }
            } catch {}
        }
    }

    try {
        const response     = await axios.get(optionThumbnailUrl, {
            responseType:  'arraybuffer',
            timeout:       5000,
            headers:       { 'User-Agent': 'Mozilla/5.0' },
        });
        const templateBuffer = Buffer.from(response.data);

        if (opencv) {
            try {
                const preview      = opencv.imread(previewPath);
                const template     = opencv.imdecode(templateBuffer);
                const canvasSize   = { w: preview.cols, h: preview.rows };
                const templateSize = { w: template.cols, h: template.rows };

                // Priority: exactBbox > characterZone > diffMask > full canvas
                let searchRegion = null;
                let offsetX = 0, offsetY = 0;

                const searchZone = exactBbox || characterZone ||
                    (diffMask?.w > 0 && diffMask.w < canvasSize.w * 0.9 ? diffMask : null);

                if (searchZone) {
                    const cx = Math.max(0, Math.min(searchZone.x, canvasSize.w - 1));
                    const cy = Math.max(0, Math.min(searchZone.y, canvasSize.h - 1));
                    const cw = Math.min(searchZone.w, canvasSize.w - cx);
                    const ch = Math.min(searchZone.h, canvasSize.h - cy);

                    if (cw > templateSize.w && ch > templateSize.h) {
                        searchRegion = preview.getRegion(new opencv.Rect(cx, cy, cw, ch));
                        offsetX = cx; offsetY = cy;
                    }
                }

                const searchArea    = searchRegion || preview;
                const previewEdge   = searchArea.bgrToGray().canny(30, 100);
                const scaleRange    = getScaleRange(diffMask, templateSize, canvasSize);

                let bestMatch = null;
                for (let scale = scaleRange.min; scale <= scaleRange.max; scale += scaleRange.step) {
                    const tw = Math.round(template.cols * scale);
                    const th = Math.round(template.rows * scale);
                    if (th < 20 || tw < 20) continue;

                    const resized       = template.resize(th, tw);
                    const templateEdge  = resized.bgrToGray().canny(30, 100);
                    const { maxVal, maxLoc } = previewEdge
                        .matchTemplate(templateEdge, opencv.TM_CCOEFF_NORMED)
                        .minMaxLoc();

                    if (!bestMatch || maxVal > bestMatch.score) {
                        bestMatch = { score: maxVal, x: maxLoc.x, y: maxLoc.y, w: tw, h: th };
                    }
                }

                if (bestMatch?.score >= 0.45) {
                    if (bestMatch.score < 0.6) {
                        const colorCorr = await colorSecondaryCheck(opencv, searchArea, template, bestMatch);
                        if (colorCorr < 0.3) {
                            console.warn(`    [LOCATOR] Rejected by color check: corr=${colorCorr.toFixed(2)}`);
                            bestMatch = null;
                        }
                    }
                }

                if (bestMatch?.score >= 0.45) {
                    console.log(`    [LOCATOR] OpenCV: score=${bestMatch.score.toFixed(2)} scale=${(bestMatch.w/template.cols).toFixed(1)}`);
                    const pad = 10;
                    return {
                        x:          Math.max(0, bestMatch.x + offsetX - pad),
                        y:          Math.max(0, bestMatch.y + offsetY - pad),
                        w:          Math.min(canvasSize.w, bestMatch.w + pad * 2),
                        h:          Math.min(canvasSize.h, bestMatch.h + pad * 2),
                        confidence: bestMatch.score,
                        source:     'opencv',
                    };
                }
            } catch (cvError) {
                console.warn(`    [LOCATOR] OpenCV error: ${cvError.message}`);
            }
        }

        // JS-SSD fallback
        const ssdZone = exactBbox || characterZone || diffMask;
        if (ssdZone?.w > 0) {
            const ssdResult = await ssdMatcher.ssdMatch(previewPath, templateBuffer, ssdZone);
            if (ssdResult) {
                console.log(`    [LOCATOR] SSD match: score=${ssdResult.confidence?.toFixed(2)}`);
                return ssdResult;
            }
        }

    } catch (err) {
        console.warn(`    [LOCATOR] Error: ${err.message}`);
    }

    // Last resort
    const fallback = exactBbox || characterZone || (diffMask?.w > 0 ? diffMask : null);
    if (fallback) {
        console.log(`    [LOCATOR] Fallback: source=${exactBbox ? 'exact_bbox' : characterZone ? 'char_zone' : 'diffmask'}`);
        return {
            ...fallback,
            source:     exactBbox ? 'exact_bbox' : characterZone ? 'character_zone' : 'diffmask',
            confidence: exactBbox ? 0.7 : 0.5,
        };
    }

    return null;
}
```

---

## 5. Exports cập nhật

```javascript
module.exports = {
    locateOptionInPreview,
    buildCharacterMapFromTimeline, // dùng để pre-build zones sau customization loop
    detectCharacterContext,        // expose để test
};
```

---

## 6. Tóm tắt thay đổi

| # | Vấn đề | Fix | Impact |
| :--- | :--- | :--- | :--- |
| 1 | Keyword list không scalable | Bỏ hẳn — dùng số cuối + pattern repeat | Hoạt động với mọi sản phẩm |
| 2 | groupTypeSequence dead code | Xóa | Code sạch hơn |
| 3 | getCharacterSearchZone out-of-bounds | Clamp + guard width < 50 | Không crash |
| 4 | getSubRegion thiếu null guard | Thêm guard | Không crash |
| 5 | Scale min 0.4 quá cao | 0.4 → 0.2 | Tìm được small diff steps |
| 6 | colorSecondaryCheck bug size + catch | Guard + neutral 0.5 | Không reject match tốt |
| 7 | axios không có timeout | timeout: 5000 | Không block case |
| 8 | Không có success logging | Thêm đầy đủ | Debug được bbox sai |
| 9 | Không có skin_delta_map | buildCharacterMapFromTimeline | Bbox từ pixel thật |

---

*Sau các fix này: locator hoạt động đúng với 1–6 nhân vật, mọi loại sản phẩm POD, không cần maintain keyword list.*