# POD Auto Test Quality Upgrade Blueprint

**Ngày tổng hợp:** 2026-03-19  
**Phạm vi:** hệ thống `engine` (Playwright + rule-based + AI review + Dashboard/Report)  
**Mục tiêu:** tối ưu **độ đúng sát reviewer người**, giảm tối đa **phán nhầm** (không tối ưu "pass rate").

---

## 1. Executive Summary

Hệ thống hiện tại có nền tảng tốt (đa tầng kiểm tra: Pixel/Color/OCR/AI/Completion/Cart) nhưng decision policy đang quá cứng ở Temporal, tạo ra nguy cơ false-positive FATAL.

Kết quả khảo sát nhanh trên dữ liệu hiện có (`web/reports`):

- Tổng report: **26**
- Tổng case: **52**
- PASS: **40**
- FAIL: **4**
- FATAL: **8**
- Trong 8 FATAL:
  - **6** case có `passed_steps == total_steps`
  - **8/8** case có `final_evaluation.ai_review.ai_verdict = PASS`
  - **8/8** case dính `temporal_violations`

**Kết luận ngắn:** hiện trạng đang nghiêng về “bắt lỗi mạnh tay”, nhưng chưa đủ calibration để ra quyết định production-grade với tỷ lệ nhầm thấp.

---

## 2. Những gì đã khảo sát trong hệ thống

## 2.1 Evidence từ code

1. Temporal threshold cực nhạy:
- `src/validators/temporal-consistency.js`
- Rule hiện tại:
  - `diffPercent > 0.1` -> violation
  - `diffPercent > 0.3` -> FATAL

2. Hard override về 0 điểm khi có temporal FATAL:
- `src/utils/reporter.js` (khối `hasFatalTemporal`)
- Nếu temporal FATAL -> `status='FATAL'` và `finalScore=0`

3. Temporal check chạy cuối pipeline nhưng chưa filter ngữ cảnh step:
- `src/cli.js` gọi `checkTemporalConsistency(customizeTimeline)` ở phase finalize.

## 2.2 Evidence từ report thực tế (PRINTERVAL_1746040)

- Case 1: `PASS`, score `86`, steps `17/18`
- Case 2: `FATAL`, score `0`, steps `17/17`, AI final verdict `PASS`
- Temporal violations case 2 có record:
  - step: `Choose Woman's Top Option`
  - diffPercent: `0.97`
  - severity: `FATAL`

=> Đây là ví dụ điển hình của **score collapse do hard-gate temporal**, không phản ánh đúng toàn bộ tín hiệu chất lượng còn lại.

---

## 3. Đánh giá maturity hiện tại (theo góc nhìn reliability)

## 3.1 Điểm mạnh

1. Có nhiều lớp signal, không phụ thuộc một chỉ số duy nhất.
2. Có lưu bằng chứng ảnh/timeline/report tương đối đầy đủ.
3. Có nền tảng Reliability Engine v2 trong code (`quality_score`, `confidence_score`, `decision`).
4. Có dashboard + export hỗ trợ kiểm tra hậu kiểm.

## 3.2 Điểm yếu tồn đọng lớn

1. **Single-signal hard kill**: 1 temporal FATAL có thể giết toàn bộ case.
2. **Chưa tách rõ** “raw quality score” và “decision gate”.
3. **Thiếu lớp REVIEW bắt buộc** cho case confidence thấp / tín hiệu mâu thuẫn.
4. **Calibration chưa hoàn chỉnh**: chưa thấy quy trình chuẩn với human-labeled benchmark và confusion matrix theo version.
5. **Temporal context chưa đủ mạnh**: chưa tận dụng thông tin `skip_diff_check`, nhóm step nhiễu/animation, độ ổn định vùng diff.

---

## 4. Nguyên nhân gốc của sai lệch “không sát người”

1. `diffPercent` nhỏ nhưng bị map severity quá cao.
2. Tín hiệu mâu thuẫn (step PASS + AI PASS + cart PASS) vẫn bị override FATAL.
3. Chưa có policy “multi-evidence consensus” để kết án nặng.
4. Không có decision confidence ở UI theo default để người vận hành biết lúc nào nên tin automation 100%.

---

## 5. Kiến trúc quyết định đề xuất (Human-like, low misclassification)

## 5.1 Tách 2 lớp: `Quality` và `Decision`

1. **Quality score**: giữ nguyên tính điểm theo Pixel/Color/OCR/AI/Completion/Cart.
2. **Decision gate**: ra `PASS_AUTO / FAIL_AUTO / REVIEW / BLOCKER` dựa trên:
  - quality score
  - confidence score
  - reason codes
  - hard constraints thật sự nghiêm trọng

> Không ép `score=0` chỉ vì 1 trigger temporal nếu các tín hiệu còn lại đồng thuận PASS.

## 5.2 Decision policy khuyến nghị

1. `BLOCKER` chỉ khi có multi-evidence nghiêm trọng:
  - ví dụ: temporal severe + cart fail, hoặc navigation fail thật.
2. `REVIEW` khi tín hiệu mâu thuẫn:
  - temporal fail nhưng AI PASS + cart PASS.
3. `PASS_AUTO` khi quality cao và confidence cao.
4. `FAIL_AUTO` khi quality thấp và confidence cao.

## 5.3 Temporal policy mới

1. Nâng threshold theo calibration thực tế (không dùng 0.1/0.3 hiện tại).
2. Không đánh severity chỉ dựa một điểm diff; thêm điều kiện:
  - số lần tái diễn
  - mức ảnh hưởng vùng mục tiêu
  - có đồng thuận từ AI/verify zone hay không
3. Bỏ qua/giảm trọng số cho step có `skip_diff_check`, menu opener, hoặc nhóm UI dễ nhiễu.

---

## 6. Lộ trình triển khai (ưu tiên theo tác động)

## P0 (1-2 tuần) - giảm false FATAL ngay

1. `src/validators/temporal-consistency.js`
- Tăng threshold tạm thời theo hướng bảo thủ với false-positive.
- Thêm filter step context (`skip_diff_check`, dropdown/menu-opener).
- Trả thêm metadata giải thích severity.

2. `src/utils/reporter.js`
- Bỏ logic auto `finalScore=0` cho mọi temporal FATAL.
- Chuyển thành:
  - `status_reason` rõ ràng
  - map sang `REVIEW` khi mâu thuẫn tín hiệu.
- Luôn giữ `raw_score` để phân tích.

3. `web/js/dashboard.js`
- Hiển thị thêm `Decision`, `Confidence`, `Reason Codes` cạnh status.
- Ưu tiên xem được lý do fail/fatal trực tiếp ở All Test Cases.

## P1 (2-4 tuần) - ra quyết định đáng tin hơn

1. Bật Reliability v2 default trong CLI pipeline.
2. Lưu đầy đủ `quality_score`, `confidence_score`, `decision_reason_codes` vào report/export.
3. Thêm rule consensus giữa temporal + AI + cart + completion.

## P2 (4-8 tuần) - chuẩn production

1. Tạo bộ benchmark có human label (>=300-500 cases).
2. Thiết lập eval định kỳ theo version:
- precision/recall theo class
- false-FATAL rate
- review-rate
3. Thiết lập quality gate trước release.

---

## 7. KPI bắt buộc để đo “sát người”

1. `False FATAL rate` (mục tiêu < 1-2%)
2. `Precision(FATAL)` (mục tiêu > 98%)
3. `Case-level agreement with human` (mục tiêu > 95%)
4. `Review rate` (mục tiêu 10-25%, tránh auto quá đà)
5. `Mean time to explain` (thời gian reviewer hiểu lý do quyết định)

---

## 8. Hướng dẫn vận hành AI đánh giá để tăng độ đúng

1. Chuẩn hóa schema output của AI bằng Structured Outputs (JSON schema strict).
2. Không nhồi toàn bộ report history vào prompt; chỉ retrieval top-k case tương tự.
3. Thiết kế rubric chấm điểm cố định, không để AI nhận xét tự do không khung.
4. Đưa few-shot từ case đã human-reviewed.
5. Tách rõ:
- AI as evidence (signal)
- Decision policy (engine)

---

## 9. Checklist kỹ thuật theo file

1. `src/validators/temporal-consistency.js`
- [ ] Rework threshold + severity mapping
- [ ] Context-aware exclusions
- [ ] Rich violation metadata

2. `src/utils/reporter.js`
- [ ] Decouple raw score vs final decision
- [ ] Remove unconditional score-zero on temporal single-hit
- [ ] Add review-state policy

3. `src/cli.js`
- [ ] Enable reliability-v2 default path
- [ ] Ensure temporal check gets context flags

4. `web/js/dashboard.js`
- [ ] Add columns/tooltip: Decision, Confidence, Reason Codes
- [ ] Expose why FAIL/FATAL at row level

5. `src/repository.js`, `src/server.js`
- [ ] Ensure API returns business status + decision fields consistently

---

## 10. Tổng hợp research internet liên quan (áp dụng trực tiếp cho POD Auto Test)

## 10.1 Visual regression / E2E ổn định

1. Playwright Visual Comparisons: cần baseline ổn định theo môi trường; hỗ trợ cấu hình ngưỡng diff, mask vùng nhiễu, animation handling.  
Nguồn: https://playwright.dev/docs/test-snapshots

2. Playwright Best Practices: ưu tiên locator có khả năng auto-wait, tách test độc lập, tránh dependency không kiểm soát để giảm flakiness.  
Nguồn: https://playwright.dev/docs/next/best-practices

3. Selenium Waits: dùng explicit waits đúng cách; tránh trộn implicit + explicit waits vì dễ gây timeout khó đoán.  
Nguồn: https://www.selenium.dev/documentation/webdriver/waits/

4. Cypress retries: retries hữu ích để khoanh vùng flaky test, nhưng không thay thế việc sửa nguyên nhân gốc.  
Nguồn: https://docs.cypress.io/app/guides/test-retries

5. BackstopJS (visual regression OSS): hỗ trợ `misMatchThreshold`, `hideSelectors`, `removeSelectors` để giảm false positives do vùng động.  
Nguồn: https://github.com/garris/BackstopJS

## 10.2 Flaky test research

1. Nghiên cứu tại Google: flakiness có thể xác định và truy gốc có hệ thống, không chỉ “retry cho qua”.  
Nguồn: https://research.google/pubs/de-flake-your-tests-automatically-locating-root-causes-of-flaky-tests-in-code-at-google/

2. Nghiên cứu WEFix: web test flakiness có thể giảm mạnh bằng xử lý waits/actionability thông minh.  
Nguồn: https://arxiv.org/abs/2402.09745

3. Nghiên cứu review về flaky tests: nhấn mạnh cần taxonomy nguyên nhân + chiến lược xử lý khác nhau theo loại flaky.  
Nguồn: https://arxiv.org/abs/2401.15788

## 10.3 AI eval reliability

1. OpenAI Evals Design Guide: cần rubric rõ, đánh giá định kỳ, chống overfit theo test set.  
Nguồn: https://developers.openai.com/api/docs/guides/evaluation-best-practices

2. OpenAI Tracing/Graders: tận dụng tracing + grader workflow để phân tích sai lệch và cải thiện độ nhất quán đánh giá.  
Nguồn: https://developers.openai.com/api/docs/guides/graders

3. OpenAI Structured Outputs: ép format JSON schema strict để giảm lỗi parse và tăng tính deterministic khi integrate vào decision engine.  
Nguồn: https://developers.openai.com/api/docs/guides/structured-outputs

---

## 11. Kết luận định hướng

Để đạt mức “sát người, tỷ lệ nhầm thấp”, trọng tâm không phải tăng thêm rule, mà là:

1. Chuẩn hóa decision policy theo confidence + consensus.
2. Giảm hard-gate cảm tính (đặc biệt temporal single-hit).
3. Thiết lập vòng đo lường chuẩn với human-labeled benchmark.
4. Biến AI từ “người phán quyết duy nhất” thành “nguồn bằng chứng có kiểm soát”.

Khi hoàn thành 4 điểm trên, hệ thống mới chuyển từ “tool chạy được” sang “tool đáng tin để vận hành”.
