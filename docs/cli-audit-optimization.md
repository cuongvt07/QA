# cli.js — Audit & Tối ưu Toàn diện

---

## 1. Tổng quan kiến trúc hiện tại

```
main()
  ├── Scan product options (1 browser context)
  ├── Dispatch N cases parallel
  │     └── runTestCase(caseIdx, optionIndex)
  │           ├── Phase 1: Navigation
  │           ├── Phase 2: Variants
  │           ├── Phase 3: Customization
  │           ├── Phase 4: Evaluation (parallel per step)
  │           │     ├── Layer 1: getDiffMask
  │           │     ├── Layer 2A: Hard gates (diff=0, diff<0.005)
  │           │     ├── Layer 3A: OCR
  │           │     ├── Layer 3B: Color verify
  │           │     ├── Layer 3C: Quick color check
  │           │     └── Layer 4: AI Judge (Locate→Verify→Judge)
  │           ├── Finalize (parallel)
  │           │     ├── checkTemporalConsistency
  │           │     ├── checkCompletion
  │           │     └── capturePreviewFast + validatePreview
  │           ├── Regression Registry check
  │           ├── Add to Cart
  │           └── Final AI Review
  └── Build + save combined report
```

---

## 2. Những gì đã tốt

**Phase 4 parallel per step** — `Promise.all(evaluationPromises)` chạy tất cả steps song song. Đúng.

**capturePreviewFast** — `canvas.toDataURL()` skip scroll. Đúng, tiết kiệm 100–150s.

**Finalize parallel** — temporal, completion, capturePreview chạy song song. Đúng.

**AI Conditional Override threshold 0.85** — đúng với architecture v3.3.

**AI ERROR → flag manual review, không PASS oan** — đúng, fix bug #4.

**Hard gate diff=0 → AUTO FAIL** — đúng.

**Noise gate diff<0.005% → AUTO PASS** — đúng.

---

## 3. Vấn đề cần fix

### Bug #1 — Regression trigger scroll (thủ phạm 100–150s)

```javascript
// Dòng ~210:
if (baseline !== previewHash) {
    console.log(`    [REGRESSION] Visual mismatch detected for ${registryKey}!`);
    previewResult.regression = true;
    previewResult.baseline_hash = baseline;
}
// SAU ĐÓ code tiếp tục xuống Final AI Review
// Final AI Review gọi: lastStepWithAfter.state_after
// → state_after là ảnh cũ từ customization, không phải final preview
// → AI nhận ảnh sai → kết quả không đáng tin
// → Và ở đâu đó sau regression có scroll được gọi lại
```

Từ log thực tế:
```
[REGRESSION] Visual mismatch detected!
    [ACTION] Scrolling footer container into view...  ← 100–150s
    [AI DEBUG] actionContext generated...
    [AI USAGE] #4: 1951 tokens
```

Regression detect xong → Final AI Review chạy → bên trong `evaluateFinalPreview()` vẫn gọi scroll. Cần fix trong `ai-evaluator.js`, không phải cli.js.

```javascript
// Fix trong cli.js: truyền finalImageBuffer thay vì state_after path

// Hiện tại — sai:
const aiFinal = await aiEvaluator.evaluateFinalPreview(
    lastStepWithAfter.state_after,  // ← ảnh cũ từ step cuối
    caseReport
);

// Đúng — dùng buffer từ capturePreviewFast đã chạy:
// Lưu buffer khi capture:
let finalPreviewBuffer = null;
const [temporalRes, completionRes, previewRes] = await Promise.all([
    checkTemporalConsistency(customizeTimeline),
    checkCompletion(...),
    (async () => {
        const tCaptureFast = Date.now();
        // Lưu vào file VÀ trả về buffer
        finalPreviewBuffer = await capturePreviewFastToBuffer(page);
        if (finalPreviewBuffer) {
            const finalPreviewPath = path.join(caseDir, 'final_preview.jpg');
            fs.writeFileSync(finalPreviewPath, finalPreviewBuffer);
            lastStepWithAfter = { state_after: finalPreviewPath }; // override
        }
        console.log(`[PERF] capturePreviewFast: ${Date.now() - tCaptureFast}ms`);
        const res = await validatePreviewImage(page);
        return res;
    })()
]);

// Final AI Review dùng path đã lưu — không scroll lại
if (aiEvaluator.enabled && previewResult.valid && finalPreviewBuffer) {
    const finalPreviewPath = path.join(caseDir, 'final_preview.jpg');
    const aiFinal = await aiEvaluator.evaluateFinalPreview(finalPreviewPath, caseReport);
    // ai-evaluator.js KHÔNG được gọi scroll — chỉ nhận path/buffer
}
```

---

### Bug #2 — Regression false positive: key không include case index

```javascript
// Hiện tại:
const registryKey = `${tcCode}:${optionLabel}`;

// Vấn đề: 2 case cùng TC nhưng option khác nhau
// Case 1: optionLabel = "Long Hair 1" → key = "TC001:Long Hair 1"  → lưu hash A
// Case 2: optionLabel = "Long Hair 2" → key = "TC001:Long Hair 2"  → lưu hash B
// Lần chạy sau case 2 option khác → hash khác → báo REGRESSION oan

// Fix: thêm caseIdx vào key
const registryKey = `${tcCode}:case_${caseIdx}:${optionLabel}`;
```

---

### Bug #3 — `capturePreviewFast` không trả về buffer

```javascript
// Hiện tại:
async function capturePreviewFast(page, outputPath) {
    // ...
    if (outputPath) fs.writeFileSync(outputPath, buffer);
    return true; // ← chỉ trả boolean, không có buffer
}

// Caller không có buffer → phải dùng lastStepWithAfter.state_after (ảnh cũ)
// → Final AI Review nhận ảnh sai

// Fix: trả về buffer
async function capturePreviewFast(page, outputPath = null) {
    try {
        const dataUrl = await page.evaluate(() => {
            const selectors = ['#customily-app canvas', 'canvas[id*="preview"]',
                               'canvas[id*="customily"]', 'canvas'];
            for (const sel of selectors) {
                const c = document.querySelector(sel);
                if (c && c.width > 100 && c.height > 100) return c.toDataURL('image/jpeg', 0.90);
            }
            return null;
        });

        if (dataUrl) {
            console.log('[PERF] canvas.toDataURL — skip scroll');
            const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
            const buffer = Buffer.from(base64, 'base64');
            if (outputPath) fs.writeFileSync(outputPath, buffer);
            return buffer; // ← trả buffer thay vì true
        }
    } catch (e) {}

    // Fallback scroll với hard cap
    console.warn('[PERF] canvas not found, fallback scroll (2s cap)');
    await page.evaluate(() => {
        document.querySelector('[id*="customily"], canvas')
            ?.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    await page.waitForTimeout(2000);
    const buffer = await page.screenshot({ type: 'jpeg', quality: 90 });
    if (outputPath) fs.writeFileSync(outputPath, buffer);
    return buffer; // ← trả buffer
}
```

---

### Bug #4 — Transition overhead không được log

```javascript
// Hiện tại:
const tTransitionStart = Date.now();
console.log(`[PERF] Transition Phase 3 -> 4 start...`);
const t4 = Date.now();
console.log(`[PERF] Transition overhead: ${t4 - tTransitionStart}ms`);
// → Log này sẽ luôn ra ~0ms vì t4 khai báo ngay sau tTransitionStart
// → Không đo được gì

// Fix: đo gap thực tế
const t3End = Date.now(); // ngay sau console.timeEnd Phase 3
// ... setup code ...
const t4Start = Date.now(); // ngay trước Phase 4
console.log(`[PERF] Gap Phase3→4: ${t4Start - t3End}ms`); // gap thật
```

---

### Bug #5 — `evaluationPromises` chạy parallel nhưng `locateOptionInPreview` có side effect

```javascript
// Trong Promise.all(evaluationPromises):
// locateOptionInPreview() download thumbnail từ CDN cho mỗi step
// N steps parallel → N concurrent HTTP requests → CDN rate limit

// Fix: throttle hoặc cache thumbnail per URL
const thumbnailCache = new Map();
async function getThumbnailBuffer(url) {
    if (thumbnailCache.has(url)) return thumbnailCache.get(url);
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
    const buffer = Buffer.from(response.data);
    thumbnailCache.set(url, buffer);
    return buffer;
}
// Reset cache sau mỗi case (không giữ giữa cases)
```

---

### Bug #6 — `checkTemporalConsistency` nhận timeline chưa có diffMask

```javascript
// Finalize chạy parallel với evaluation:
const [temporalRes, completionRes, previewRes] = await Promise.all([
    checkTemporalConsistency(customizeTimeline),  // ← chạy song song
    // ...
]);

// Nhưng evaluation cũng đang chạy song song trong Promise.all(evaluationPromises)
// → customizeTimeline có thể chưa có diffMask khi temporal check bắt đầu

// Fix: Finalize chỉ chạy SAU KHI evaluation xong
await Promise.all(evaluationPromises); // Phase 4 xong hoàn toàn
// Rồi mới finalize:
const [temporalRes, completionRes, previewRes] = await Promise.all([...]);
```

Kiểm tra lại code — `await Promise.all(evaluationPromises)` ở dòng ~175 và finalize ở dòng ~190. Nếu chúng nằm trong cùng block sequential thì không sao, nhưng cần verify không có async leak.

---

### Bug #7 — Score không reflect cart source

```javascript
// buildCaseReport nhận cartResult.success
// Nhưng không biết cart success bằng method nào
// → Không thể phân biệt "PASS vì button state" vs "PASS vì URL redirect"

// Fix: truyền cartResult.method vào report
caseReport.final_evaluation.cart_result = cartResult.success ? 'PASS' : 'FAIL';
caseReport.final_evaluation.cart_method = cartResult.method; // 'button_state_change', 'url_redirect'...
```

---

## 4. Performance Issues

### Issue 1 — Phase 4 parallel với locator download

12 steps × 1 HTTP request = 12 concurrent CDN requests. Với CDN có rate limit → một số request bị delay → phase 4 chờ lâu hơn cần thiết. Fix: thumbnail cache như Bug #5.

### Issue 2 — `calculateVisualDiff` và `getDiffMask` đọc cùng file 2 lần

```javascript
const [{ diffPercent }, diffMask] = await Promise.all([
    calculateVisualDiff(step.state_before, step.state_after),
    getDiffMask(step.state_before, step.state_after)
]);
// Cả 2 đều đọc state_before và state_after
// → 4 file reads thay vì 2

// Fix: đọc file 1 lần, pass buffer
const [beforeBuf, afterBuf] = await Promise.all([
    fs.promises.readFile(step.state_before),
    fs.promises.readFile(step.state_after),
]);
const [{ diffPercent }, diffMask] = await Promise.all([
    calculateVisualDiffFromBuffers(beforeBuf, afterBuf),
    getDiffMaskFromBuffers(beforeBuf, afterBuf),
]);
```

### Issue 3 — Final AI Review path không đúng

```javascript
// Hiện tại:
const aiFinal = await aiEvaluator.evaluateFinalPreview(
    lastStepWithAfter.state_after,  // ← ảnh After của step cuối (tương tác cuối)
    caseReport
);
// Đây không phải ảnh final preview hoàn chỉnh
// Đây là ảnh After khi nhập tên người cuối cùng
// → AI nhìn vào ảnh chỉ có 1 thay đổi nhỏ (text), không phải toàn bộ product

// Đúng: dùng finalPreviewBuffer từ capturePreviewFast
```

---

## 5. Minor Issues

### 5.1 — `phaseDurations.phase_ai_review` đo sai

```javascript
const t5 = Date.now();
try {
    const aiFinal = await aiEvaluator.evaluateFinalPreview(...);
    // ...
} catch (e) { ... }
phaseDurations.phase_ai_review = Date.now() - t5;
```

`t5` khai báo TRƯỚC try block nhưng assignment ở NGOÀI try. Nếu throw → phase_ai_review = thời gian đến lúc throw, không phải 0. Đây là minor, không ảnh hưởng logic.

### 5.2 — `caseReport.phase_durations = phaseDurations` bị ghi 2 lần

```javascript
// Dòng ~230: buildCaseReport truyền phase_durations
const caseReport = buildCaseReport({ ..., phase_durations: phaseDurations });

// Dòng ~260: ghi lại
caseReport.phase_durations = phaseDurations; // ← dư thừa
```

### 5.3 — `DIFF_AUTO_PASS_ZERO` và `DIFF_AUTO_PASS_HIGH` import nhưng không dùng

```javascript
const DIFF_AUTO_PASS_ZERO = process.env.DIFF_AUTO_PASS_ZERO === 'true';
const DIFF_AUTO_PASS_HIGH = parseFloat(process.env.DIFF_AUTO_PASS_HIGH || '50');
// Cả 2 không được reference trong code → dead code
```

---

## 6. Tóm tắt fix theo thứ tự ưu tiên

| # | Bug | Impact | Effort | Fix location |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `capturePreviewFast` trả `true` thay vì buffer | Final AI Review nhận ảnh sai | 15 phút | `cli.js` |
| 2 | Regression scroll trong `evaluateFinalPreview` | 100–150s/case | 30 phút | `ai-evaluator.js` |
| 3 | Regression key không có caseIdx | False positive | 5 phút | `cli.js` |
| 4 | Temporal check chạy trước evaluation xong | Thiếu diffMask | 5 phút | `cli.js` (verify order) |
| 5 | Thumbnail download N lần parallel | CDN rate limit | 20 phút | `locator.js` hoặc `cli.js` |
| 6 | File đọc 2 lần cho diff+mask | I/O dư thừa | 30 phút | `cli.js` + utils |
| 7 | `DIFF_AUTO_PASS_ZERO/HIGH` dead code | Code smell | 5 phút | `cli.js` |

---

## 7. Dự kiến sau fix

```
Hiện tại:                    Sau fix 1+2+3:
  Time/case:  265s      →      ~115s   (-57%)
  Regression: false pos →      chính xác
  Final AI:   ảnh sai   →      final preview thật

Score impact:
  Final AI nhận đúng ảnh → verdict chính xác hơn
  Regression không false positive → không trigger re-verify dư thừa
```

---

*Audit based on: cli.js v3.0 + report PRINTERVAL_1747795 + perf logs thực tế*
