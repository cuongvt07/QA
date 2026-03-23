# AI QA Split Architecture Overview (v3.3)

> **Changelog từ v3.2**: Fix 4 gap phát hiện từ report thực tế (PRINTERVAL_1747726, PRINTERVAL_1747795).  
> Gap 1: diffMask full canvas → crop không thật. Gap 2: Cart score leak vào AI score. Gap 3: AI override không có điều kiện. Gap 4: Temporal Consistency và Render Regression chưa có.

---

## 1. Core Workflow: The "Locate-Verify-Judge" Pipeline

### 🔍 Stage 1: LOCATE (Where is the change?)

**Goal**: Tìm bounding box chính xác (x, y, w, h) của element đã thay đổi.

**Method — theo thứ tự ưu tiên**:

1. **Delta Fingerprint** (Primary, $0, pixel-exact)  
   Dùng `pixelmatch` output để tìm tọa độ thật của vùng thay đổi.  
   Chỉ tin khi `diffMask.w < canvas.width × 0.8` — nếu mask = full canvas thì bỏ qua.  
   Độ chính xác: pixel-exact · Chi phí: $0, ~50ms

2. **OpenCV Template Matching** (Secondary, dùng khi có option_thumbnail)  
   Adaptive scale từ diffMask → Canny edge → HSV color secondary check.  
   Absolute threshold ≥ 0.45 AND relative gap ≤ 0.1 từ maxVal.  
   Độ chính xác: ±5–15px (IoU > 0.75 target) · Chi phí: $0, ~50–150ms

3. **JS-SSD Matcher** (Fallback khi không có OpenCV)  
   Sliding window SSD, step=4px, row sampling mỗi 2px.  
   Search trong diffMask zone, không quét full canvas.  
   Độ chính xác: ±15–30px · Chi phí: $0, ~500ms

4. **AI Estimate** (Last resort)  
   Normalize bbox% → pixel. Sanity check bounds.  
   **Không dùng để tính score** — chỉ vẽ báo cáo với nét đứt vàng.  
   Độ chính xác: ±50–100px (hallucination risk cao)

**Output**: `{ x, y, w, h, confidence, source: 'pixel'|'opencv'|'js-ssd'|'ai-estimate' }`

---

### ✅ Stage 2: VERIFY (Is it technically correct?)

**Goal**: Deterministic code-based checks trên vùng đã crop chính xác.

**Checks**:

- **Color** (`colorthief` + HSV): Crop bbox → dominant color → Euclidean distance vs hex. PASS < 25 | WARNING 25–50 | FAIL > 50
- **OCR** (`tesseract.js`): Chỉ cho `text_input`. Crop delta zone → Levenshtein similarity. Signal bổ sung, không quyết định độc lập.
- **Temporal Consistency** *(mới v3.3)*: Vùng step N-1 còn nguyên trong ảnh After step N? Phát hiện data loss. FATAL < 0.50 similarity → override toàn bộ score.
- **Completion Check**: Final diff vs baseline tương ứng N customizations. completionRatio > 0.75 → PASS.

**Output**: `{ color, ocr, temporal, completion }` — raw scores và flags.

---

### 🏛️ Stage 3: JUDGE (Is it visually correct?)

**Goal**: Semantic verdict từ AI — chỉ làm việc mà code không làm được.

**3 ảnh gửi AI**:
1. Full Product Preview 768px (context)
2. Cropped Element Zone 256px (detail — từ bbox Stage 1)
3. Reference Thumbnail (ground truth — option image)

**Ground Truth Injection**: Truyền expected values vào prompt trước khi hỏi. AI ở verification mode, không phải discovery mode.

**Conditional Override** *(fix từ v3.2)*:
```javascript
// AI chỉ override code failure khi confidence đủ cao
if (aiVerdict === 'PASS' && aiConfidence >= 0.85) {
  return aiVerdict; // override — AI thấy rõ ràng
} else {
  return codeResult; // giữ code result
}
// Không bao giờ override khi temporal = FATAL
```

**Dual-Model Routing**:
- `gpt-4o-mini`: mặc định tất cả step-level calls
- `gpt-4o`: escalate khi mini confidence < 0.80 hoặc temporal FATAL

**Prompt theo step type** (fix image_option FAIL oan):
- `image_option` → "Does the cropped zone show a graphic matching the thumbnail? Do NOT look for text."
- `text_input` → "Is the text '{value}' visible? Not overflowing?"
- `color_option` → "Has the color of the element changed? Do NOT look for text."

**Output**: `{ ai_verdict, ai_confidence, reason, bbox_confirmed }`

---

## 2. Score Merger (fix từ v3.2)

```
Pixel:      15%   change detection gate
Color:      15%   code đo, deterministic
OCR:        20%   tesseract trên crop zone
AI Vision:  25%   semantic judge
Completion: 15%   cross-check N customizations
Cart:       10%   TÁCH RIÊNG — không ảnh hưởng AI score
────────────────
Total:     100%
```

**Hard Gates** — override score, không qua merger:
```
diff = 0 sau action step     → AUTO FAIL
temporal.severity = FATAL    → FATAL override tất cả
diff < 0.01% (noise)         → AUTO PASS, skip AI
```

**Decision thresholds**:
```
≥ 0.90   → AUTO PASS
0.70–0.89 → FLAG (human review queue)
< 0.70   → AUTO FAIL
```

---

## 3. Technology Stack

| Layer | Technology | Purpose | Status |
| :--- | :--- | :--- | :--- |
| Automation | Playwright | Browser control, screenshots | Stable |
| Logic | Node.js v20+ | Core engine, CLI | Stable |
| Image Processing | Sharp | Crop, resize, pixel prep | Stable |
| Computer Vision | opencv4nodejs | Template matching, Canny edge | Stable |
| CV Fallback | JS-SSD (ssd-matcher.js) | Template match khi không có OpenCV | Stable |
| Delta Detection | Pixelmatch + PNGjs | diffMask, change area | Fix needed* |
| Color Analysis | ColorThief | Dominant color từ crop zone | Stable |
| OCR | Tesseract.js | Text extraction từ crop zone | ~85% accuracy |
| OCR upgrade | Azure Vision API | Text + bbox 8 điểm, ~99% | Planned |
| AI Vision | GPT-4o-mini / 4o | Semantic judge, conditional override | Stable |

> *Fix needed: diffMask đang trả về full canvas (x:0, y:0, w:648, h:653). Delta fingerprint phải được fix trước mọi optimization khác — token efficiency và crop accuracy đều phụ thuộc vào đây.

---

## 4. Key Implementation Strategies

- **Hardware Independence**: Fallback chain OpenCV → JS-SSD → AI estimate đảm bảo tool chạy mọi môi trường.

- **Token Efficiency**: Crop 256px cho step-level, 768px cho Final Review. **Phụ thuộc diffMask đúng** — fix delta fingerprint là prerequisite.

- **Race-Condition Safety**: Random suffix cho temp files (`verify-{timestamp}-{random}.jpg`).

- **Weighted Scoring**: 6 thành phần độc lập. Cart 10% tách riêng, không leak vào AI Vision score.

- **Audit Pass Logic**: diff < 0.5% → Auto-Pass, skip AI. Khác với Hard Fail Gate (diff = 0 → Auto-Fail).

- **Ground Truth Injection**: Expected values truyền vào prompt trước khi hỏi AI → verification mode → accuracy ~88–92% vs ~65% discovery mode.

- **Temporal Consistency** *(mới)*: Cross-check data loss sau customization loop. FATAL → force gpt-4o Final Review.

- **Render Regression Registry** *(planned)*: Hash final preview theo `tcCode:optionSignature` để phát hiện widget Customily tự update phá render behavior.

---

## 5. Bounding Box — Nguồn và Độ tin cậy

| Source | Màu viền | Style | Dùng tính score |
| :--- | :--- | :--- | :--- |
| `pixel` (delta fingerprint) | Xanh đậm #00CC44 | Solid 2px | ✅ |
| `opencv` (template match) | Xanh nhạt #44FF88 | Solid 1px | ✅ |
| `js-ssd` | Xanh nhạt #44FF88 | Solid 1px | ✅ |
| `ai-estimate` | Vàng cam #FFAA00 | Dashed 1px | ❌ hiển thị only |

---

## 6. Known Issues & Roadmap

| Issue | Severity | Status |
| :--- | :--- | :--- |
| diffMask = full canvas (648×653) | Critical | Fix now — blocks everything |
| Cart score leak vào AI score | High | Fixed in v3.3 |
| AI override không có điều kiện | High | Fixed in v3.3 |
| image_option prompt tìm text thay vì hình | High | Fixed in v3.3 |
| Temporal Consistency chưa implement | High | Sprint 2 |
| OCR accuracy ~85% (tesseract on canvas) | Medium | Azure OCR planned |
| Render Regression registry | Medium | Sprint 3 |
| actionContext 13 dòng → cần filter menu_opener | Low | Quick fix |

---

## 7. Performance Targets

| Phase | Hiện tại | Target sau fix |
| :--- | :--- | :--- |
| customization (12 steps) | ~71s | ~35s (-51%) |
| evaluation (parallel) | ~6.4s | ~3s (-53%) |
| ai_review + capture | ~14s | ~2.5s (-82%) |
| Total / case | ~275s | ~140s (-49%) |
| Total / TC (2 cases parallel) | ~510s | ~155s (-70%) |

---

*v3.3 — Updated based on real report analysis: PRINTERVAL_1747726, PRINTERVAL_1747795*  
*Previous version: v3.2 — Initial Locate-Verify-Judge architecture*
