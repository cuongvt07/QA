# Chi tiết Luồng Test & Công nghệ Sử dụng (E2E Customily Tester)

Tài liệu này mô tả chi tiết quy trình thực thi của một luồng test (Test Flow) từ lúc bắt đầu cho đến khi ra báo cáo cuối cùng, kèm theo các công nghệ lõi được áp dụng.

---

## 1. Tổng quan Luồng thực thi (6 Giai đoạn)

Hệ thống vận hành theo mô hình tuyến tính nhưng có khả năng tự điều chỉnh (self-adaptive) dựa trên phản hồi của trang web.

### Giai đoạn 1: Khởi tạo & Làm sạch (Initialization)
- **Công nghệ**: `Playwright (Chromium)`, `Javascript Injection`.
- **Hành động**:
  - Khởi tạo trình duyệt ở chế độ Headless (nếu bật).
  - Inject script `ensureCleanPage()` để ẩn/xóa các popup quảng cáo, tracking, liên hệ vốn thường làm gián đoạn automation.
  - Lắng nghe sự kiện console/network để phát hiện lỗi ngay khi vừa tải trang.

### Giai đoạn 2: Khám phá & Chọn biến thể (Discovery)
- **Công nghệ**: `CSS Selectors`, `Mutation Analysis`.
- **Hành động**:
  - Tự động quét các biến thể sản phẩm ngoài widget (Style, Size, Color).
  - Thực hiện chọn biến thể hợp lệ để mở khóa nút "Add to Cart" của trang gốc.
  - Quét cấu trúc Customily Widget để xác định các Group options.

### Giai đoạn 3: Tương tác & Cá nhân hóa (Customization)
- **Công nghệ**: `Automated Form Filler`, `Dynamic Rescan`.
- **Hành động**:
  - Duyệt qua từng Option Group:
    - `text_input`: Tự động nhập text mẫu (hoặc theo data test).
    - `image_option/dropdown`: Chọn ngẫu nhiên hoặc theo chỉ định.
    - `file_upload`: Tự động tải ảnh từ folder `images/`.
  - **Đặc điểm**: Sau mỗi thao tác, hệ thống sẽ quet lại DOM để phát hiện các "nhánh" option ẩn vừa hiện ra (Sub-groups).

### Giai đoạn 4: Đợi thông minh (Intelligent Waiting)
- **Công nghệ**: `Network Intercepting`, `smartWait`.
- **Hành động**:
  - Lắng nghe các request XHR/Fetch.
  - **Cải tiến Phase 16**: Loại bỏ các domain tracking (Google Analytics, Facebook Pixel, v.v.) khỏi danh sách chờ.
  - Hệ thống chỉ dừng lại chờ khi có API render của Customily đang chạy, giúp tiết kiệm 20-30s mỗi case.

### Giai đoạn 5: Kiểm định 3 lớp (3-Tier Validation)
Đây là giai đoạn quan trọng nhất để đảm bảo độ chính xác.

- **Lớp 1: Visual Diff (Pixel-level)**: Sử dụng `pixelmatch` + `pngjs` (Async). So sánh ảnh trước và sau khi tương tác. Nếu thay đổi > 0.01% thì coi là có thay đổi hình ảnh.
- **Lớp 2: AI Vision Review (Semantic-level)**: 
  - Gửi ảnh sang `gpt-4o-mini` (theo step) hoặc `gpt-4o` (review cuối).
  - AI đánh giá xem thay đổi có "đẹp" và "đúng" về mặt thẩm mỹ không.
- **Lớp 3: System Audit (Health-level)**: Kiểm tra log console và các API error. Nếu API trả về `403` hoặc `500` từ server Customily, step sẽ bị đánh dấu là FATAL.

### Giai đoạn 6: Tổng hợp & Báo cáo (Reporting)
- **Công nghệ**: `Node.js FS`, `JSON Aggregator`.
- **Hành động**:
  - Gom toàn bộ timeline, ảnh chụp, kết quả AI vào file `report.json`.
  - Vẽ bounding box trực quan lên các vị trí AI phát hiện thay đổi.
  - Lưu snapshot HTML để debug offline.

---

## 2. Bảng tổng hợp Công nghệ cốt lõi

| Thành phần | Công nghệ / Library | Vai trò |
| :--- | :--- | :--- |
| **Logic Core** | Node.js (ES6/CommonJS) | Điều phối luồng và xử lý file. |
| **Browser Driver** | Playwright (Microsoft) | Điều khiển trình duyệt, chụp ảnh, quản lý context. |
| **Image Processing** | Sharp, pngjs, pixelmatch | Tối ưu ảnh, parse dữ liệu PNG, so sánh điểm ảnh. |
| **AI Evaluation** | OpenAI API (GPT-4o/4o-mini) | Đánh giá nội dung hiển thị của bản preview. |
| **Data Storage** | Local JSON, File System | Lưu trữ test cases, runs và reports. |
| **Reporting UI** | HTML5, Vanilla CSS, JS | Dashboard hiển thị kết quả trực quan. |

---

## 3. PHƯƠNG ÁN XỬ LÝ "TỐI ƯU NHẤT" ĐANG ÁP DỤNG

Để đạt tỉ lệ sai sót thấp nhất, hệ thống đang áp dụng các "quy tắc vàng":

1. **Async Everywhere**: Mọi thao tác I/O (đọc file, xử lý ảnh, gọi API) đều chạy bất đồng bộ để không làm treo luồng chính khi chạy hàng chục case cùng lúc.
2. **Fallback Selectors**: Hệ thống không chỉ tìm theo 1 ID cố định mà tìm theo "đặc điểm nhận dạng" (ví dụ: `[id*="customily"]`), giúp tool không bị chết khi web đổi giao diện nhẹ.
3. **Audit Mode Optimization**: Tự động thông qua (Auto-pass) các thay đổi cực nhỏ (noise) để AI tập trung vào các lỗi lớn, giúp giảm chi phí API và tăng tốc độ trả kết quả.
