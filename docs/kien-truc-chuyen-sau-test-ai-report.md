# Kiến trúc Chuyên sâu: Luồng Test, AI & Hệ thống Báo cáo

Tài liệu này cung cấp chi tiết kỹ thuật ở mức thấp (Low-level) về cách hệ thống vận hành, ra quyết định thông qua AI và cấu trúc dữ liệu của báo cáo.

---

## 1. Chi tiết Luồng Test (10 Bước Thực thi)

Mỗi "Case" trong một "Test Case" (TC) sẽ trải qua chu trình 10 bước nghiêm ngặt:

1.  **Browser Context Isolation**: Tạo một trình duyệt sạch hoàn toàn (Incognito), xóa sạch cache và cookie để tránh nhiễu dữ liệu cũ.
2.  **Anti-Interference (Lọc nhiễu)**: Chạy script xóa các thẻ `<iframe>` không liên quan, các nút Chat (Intercom, Crisp) và các vùng phủ (Overlays) bằng JS.
3.  **Variant Pre-selection**: Tìm và chọn các thuộc tính bắt buộc của Shopify/WooCommerce (như Size: M, Style: Unisex) để kích hoạt Customily.
4.  **Widget Handshaking**: Chờ đợi sự kiện `CustomilyReady` hoặc sự hiện diện của `#canvas` để đảm bảo widget đã nạp xong data.
5.  **Sequential Interaction Loop**: 
    - Chụp ảnh `State Before`.
    - Thực hiện hành động (Type/Click/Upload).
    - Chụp ảnh `State After`.
    - Lưu vào `customizeTimeline`.
6.  **Intelligent Async Wait (SmartWait 1.5)**: 
    - Lắng nghe traffic mạng.
    - Nếu có request tới `api.customily.com` -> Đợi phản hồi.
    - Nếu không có request trong 1s -> Tiếp tục bước tiếp theo.
7.  **Multi-Tier Evaluation**: Chạy song song (Parallel) việc tính toán Pixel Diff và gửi ảnh sang AI.
8.  **Cart Verification**: Bấm "Add to Cart", theo dõi thay đổi của URL hoặc sự xuất hiện của Side-cart. Chụp ảnh vùng mini-cart làm bằng chứng.
9.  **Post-mortem Snapshot**: Nếu kết quả là `FAIL`, hệ thống tự động lưu lại toàn bộ nội dung HTML (Snapshot) và Console Logs để kỹ thuật viên có thể mở lại trang web lỗi ngay trên máy cục bộ.
10. **Resource Cleanup**: Đóng browser context, giải phóng bộ nhớ RAM.

---

## 2. Hệ thống AI Evaluation (Trí tuệ nhân tạo)

Hệ thống sử dụng chiến thuật **Dual-Model** để tối ưu chi phí và độ chính xác:

### A. Step-level AI (GPT-4o-mini)
- **Nhiệm vụ**: Đánh giá từng bước nhỏ (ví dụ: vừa nhập tên "Alex").
- **Logic**: So sánh ảnh "Trước" và "Sau". 
- **Quy tắc quyết định**:
    - Nếu Pixel Diff = 0 nhưng AI thấy có thay đổi -> Ghi nhận lỗi render (Canvas đứng im).
    - Nếu AI thấy Text bị tràn (Overflow) hoặc màu chữ trùng màu nền -> Đánh dấu FAIL kèm lý do thẩm mỹ.

### B. Final Review AI (GPT-4o)
- **Nhiệm vụ**: Đánh giá tổng thể sản phẩm cuối cùng dựa trên tất cả các hành động đã thực hiện.
- **Dữ liệu đầu vào**: Ảnh preview cuối cùng + Danh sách các giá trị người dùng đã chọn (Ví dụ: "User đã chọn Style: T-shirt, Text: Hello, Image: Dog").
- **Phát hiện vật thể (Object Detection)**: 
    - AI tự xác định tọa độ (X, Y, W, H) của các vùng đã tùy chỉnh.
    - Hệ thống dùng tọa độ này để vẽ Bounding Box màu sắc lên báo cáo.

---

## 3. Cấu trúc Báo cáo (Report Detail)

File `report.json` và giao diện Dashboard chứa các thông tin cực kỳ chi tiết:

### - Timeline Dashboard
Mỗi bước trong Timeline bao gồm:
- **Action**: Loại hành động (text_input, dropdown...).
- **Value**: Giá trị đã nhập/chọn.
- **Visual Evidence**: Hai ảnh (Before/After) đặt cạnh nhau có tính năng Zoom để soi điểm khác biệt.
- **Diff Score**: Con số chính xác đến 0.01% diện tích thay đổi.
- **AI Verdict**: Lời giải thích của AI (Ví dụ: "The text 'Alex' appeared correctly in the center area").

### - Error & Fatal Tracking
Không chỉ báo FAIL, hệ thống phân loại lỗi:
- **UI_MISMATCH**: Ảnh không đổi hoặc đổi sai vị trí.
- **API_FATAL**: Lỗi server (404, 500) khiến không render được ảnh.
- **CART_ERROR**: Bấm nút mua nhưng giỏ hàng không cập nhật.
- **JS_RUNTIME_ERROR**: Các lỗi Javascript crash trên trình duyệt khách hàng.

### - Cart Evidence
 Một mục riêng hiển thị ảnh chụp vùng giỏ hàng, giúp kiểm tra xem ảnh preview có được truyền đúng vào giỏ hàng (Cart Item Image) hay không.

---

## 4. Giải pháp Tối ưu Tỉ lệ Sai sót (Precision Strategy)

1.  **Threshold 0.01%**: Loại bỏ các nhiễu pixel nhỏ do font chữ rendering hoặc bóng đổ (shadow).
2.  **Audit Mode Pass**: Nếu một bước được xác định là "Auto-pass" (như click mở menu), hệ thống sẽ không tốn tiền gọi AI cho bước đó.
3.  **Variant Selector Auto-healing**: Nếu selectors mặc định của Style/Size bị sai, hệ thống sẽ quet tất cả các thẻ `<select>` và `<label>` để tìm từ khóa "Size" hoặc "Style" để tự click.
