# Đánh giá Hệ thống & Chiến lược Tối ưu (E2E Customily Tester)

Bản đánh giá tổng thể này nhằm cung cấp cái nhìn sâu về hiện trạng, các rủi ro tiềm ẩn và lộ trình tối ưu để đạt độ chính xác cao nhất (99%+) và lỗi thấp nhất.

---

## 1. Đánh giá Hệ thống Hiện tại (Health Check)

### Điểm mạnh (Assets)
- **Mô hình Đa lớp (Triple-Layer Validation)**: Kết hợp Pixel Diff (nhanh), AI Vision (thông minh) và Network/JS Audit (sâu). Đây là cách tiếp cận tốt nhất hiện nay cho các hệ thống UI phức tạp.
- **Tốc độ (Speed)**: Với các cải tiến Phase 16 (Async PNG, SmartWait 1s), hệ thống đã đạt ngưỡng tối ưu về thời gian thực thi (giảm ~40-50% so với bản cũ).
- **Độ linh hoạt (Flexibility)**: Khả năng tự động quet biến thể (Style/Size) và xử lý dynamic customizer giúp tool thích nghi với nhiều loại giao diện khác nhau mà không cần cấu hình cứng.

### Điểm yếu & Rủi ro (Weaknesses & Risks)
- **Phụ thuộc vào AI Cost/Speed**: Việc dùng `gpt-4o` cho Final Review có độ chính xác cao nhưng làm tăng chi phí và thời gian đáp ứng (Phase 5 thường mất 10-15s).
- **Nhiễu UI (UI Noise)**: Các hiệu ứng animation, loading mờ dần, hoặc popups bất ngờ vẫn có thể gây sai lệch trong ảnh chụp "After".
- **Hạn chế OCR**: Hiện tại AI đánh giá text dựa trên hình ảnh chung, đôi khi không phát hiện được lỗi sai 1-2 ký tự (typo) nếu không được chỉ định OCR cụ thể.

---

## 2. Các Case phổ biến & Cách xử lý (Common Scenarios)

| Kịch bản | Rủi ro | Giải pháp tối ưu |
| :--- | :--- | :--- |
| **Input Text dài** | Text tràn khung hoặc bị che khuất | AI Evaluation đã có prompt check "overlapping", nên giữ `gpt-4o` cho bước này. |
| **Upload ảnh lớn** | Thời gian render server lâu (20s+) | `SmartWait` hiện tại đã có retry, nhưng khuyến khích dùng ảnh test < 2MB. |
| **Popup "Related Products"** | Che mất nút Add to Cart | `ensureCleanPage` hiện tại đã ẩn hầu hết, nếu gặp popup mới cần bổ sung selector vào `browser.js`. |
| **Biến thể (Style/Size) yêu cầu** | Không bấm được Add to Cart nếu chưa chọn | Đã có `handleProductVariants`, nhưng cần update list `variantSelectors` nếu web đổi class. |

---

## 3. Lộ trình Tối ưu hóa (Optimization Roadmap)

### Bước 1: Giảm thiểu sai sót (Precision)
- **OCR Integration**: Kích hoạt `tesseract.js` để kiểm tra chính xác nội dung text trong các trường `text_input`. Pixel diff chỉ báo có thay đổi, AI báo đẹp, OCR sẽ báo đúng chính tả.
- **Self-Healing Selectors**: Cải tiến logic tìm Customizer. Nếu không tìm thấy bằng class mặc định, tool sẽ quet theo cấu trúc cây DOM (ví dụ: tìm thẻ `iframe` của Customily).

### Bước 2: Tối ưu hiệu năng (Performance)
- **Caching AI Results**: Nếu một option (ví dụ: "Style A") đã được AI đánh giá PASS nhiều lần, có thể cached kết quả để skip AI cho các lần chạy sau nếu mã hash của ảnh chụp không đổi.
- **Headless Optimization**: Chạy 100% ở chế độ headless và vô hiệu hóa việc tải fonts/images không cần thiết (ngoại trừ preview) để tiết kiệm bandwidth.

### Bước 3: Nâng cấp Báo cáo (UX)
- **Video Playback**: Playwright có tính năng quay video script chạy. Có thể tích hợp để xem lại chính xác tool đã làm gì khi gặp lỗi FATAL.

---

## 4. Khuyến nghị cho Người dùng (Best Practices)

1. **Chuẩn bị môi trường**: Đảm bảo `.env` đã bật `AUDIT_MODE=true` nếu muốn tool tự động bỏ qua các lỗi nhỏ (0.01%) để tiết kiệm thời gian review thủ công.
2. **Quản lý Test Case**: Nên chia nhỏ các Case (TC). Thay vì chạy 1 TC với 50 options, hãy chạy thành 5 TC, mỗi TC 10 options để tận dụng khả năng chạy song song (Concurrency).
3. **Giám sát Logs**: Luôn theo dõi `Phase 4 (Evaluation)` và `Phase 5 (AI Review)` trong console. Nếu Phase 4 lâu -> do CPU/Máy chủ chậm. Nếu Phase 5 lâu -> do OpenAI phản hồi chậm.

> [!TIP]
> **Hướng tối ưu nhất**: Kết hợp `gpt-4o-mini` cho các bước trung gian và `gpt-4o` cho bước cuối cùng (Add to Cart) để cân bằng giữa chi phí và độ an toàn.
