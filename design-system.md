# Dashboard Management UI - Design System

Tài liệu này định nghĩa hệ thống thiết kế (Design System) cho giao diện quản lý của Automated Custom Product Testing Tool.

Giao diện được xây dựng bằng **HTML, Vanilla CSS và JavaScript**, tập trung vào hiệu ứng thị giác ấn tượng (Premium Aesthetics), tương tác mượt mà (Dynamic Animations) và chế độ Dark Mode mặc định.

---

## 1. Màu sắc (Color Palette)

Hệ thống sử dụng các tông màu tối (Dark theme) điểm xuyết bằng các màu nhấn rực rỡ (Vibrant accents).

### Nền (Backgrounds)
- **`--bg-main`**: `#0f172a` (Slate 900) - Nền chính của toàn bộ trang.
- **`--bg-surface`**: `rgba(30, 41, 59, 0.7)` (Slate 800 + Opacity) - Nền của các Panel, Card (kết hợp với backdrop-filter).
- **`--bg-elevated`**: `#334155` (Slate 700) - Nền của các Popover, Dropdown.

### Màu Nhấn (Accents)
- **`--accent-primary`**: `#3b82f6` (Blue 500) - Nút bấm chính, tab đang chọn.
- **`--accent-primary-hover`**: `#2563eb` (Blue 600)
- **`--accent-success`**: `#10b981` (Emerald 500) - Trạng thái test thành công (Pass).
- **`--accent-warning`**: `#f59e0b` (Amber 500) - Trạng thái cảnh báo, retry.
- **`--accent-danger`**: `#ef4444` (Red 500) - Trạng thái test lỗi (Fail).

### Văn bản (Typography)
- **`--text-primary`**: `#f8fafc` (Slate 50) - Tiêu đề chính, Text nổi bật.
- **`--text-secondary`**: `#94a3b8` (Slate 400) - Đoạn văn, Label mô tả.
- **`--border-subtle`**: `rgba(255, 255, 255, 0.1)` - Viền cho các Card, Input.

---

## 2. Kiểu chữ (Typography)

Sử dụng Google Fonts mang phong cách công nghệ, hiện đại.
- **Font Face**: `'Inter', sans-serif` (cho UI Text) và `'Fira Code', monospace` (cho Error Logs, Code snippets).
- **Kích cỡ**: 
  - `h1`: 2rem (32px), `font-weight: 700`
  - `h2`: 1.5rem (24px), `font-weight: 600`
  - `body`: 1rem (16px), `font-weight: 400`
  - `small`: 0.875rem (14px)

---

## 3. Hiệu ứng Kính (Glassmorphism Effect)

Tạo cảm giác chiều sâu (depth) cho UI:
```css
.glass-panel {
    background: var(--bg-surface);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--border-subtle);
    border-radius: 16px;
    box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
}
```

---

## 4. Components (Thành phần giao diện)

### 4.1. Nút bấm (Buttons)
- **Primary Button**: Nền `--accent-primary`, chữ trắng, bo góc `8px`. Có hiệu ứng glow nhẹ khi hover.
- **Ghost/Outline Button**: Nền trong suốt, viền `--border-subtle`, chuyển màu nền sáng hơn nhẹ khi hover.
- **Transitions**: `transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);`

### 4.2. Thẻ trạng thái (Status Badges)
- **PASS**: Nền chữ màu `--accent-success` pha với 15% opacity, chữ cùng màu `success`.
- **FAIL**: Nền chữ màu `--accent-danger` pha 15% opacity, chữ cùng màu `danger`.
- **RUNNING**: Nền vàng/xanh lam pha 15%, kết hợp với icon xoay 360 độ (Spinner animaton).

---

## 5. Chuyển động (Animations / Micro-interactions)

- **Hover Card**: Phóng to nhẹ (`transform: translateY(-2px) scale(1.01)`) và tăng cường độ sáng / shadow khi di chuột lên các bảng test.
- **Fade In Up**: Các component khi render lần đầu sẽ trượt từ dưới lên và mờ nhạt dần ra (Opacity 0 -> 1, TranslateY 10px -> 0).
- **Pulse Error**: Các icon chỉ báo lỗi nghiêm trọng sẽ có hiệu ứng `pulse` đỏ nhẹ để thu hút sự chú ý.
- **Loading Skeleton**: Dùng background gradient chuyển động từ trái sang phải để hiển thị trạng thái đang tải dữ liệu.

---

## 6. Layout Skeletons

- **Side Navigation (Sidebar)**: Cố định bên trái (chiều rộng khoàng `260px`), chứa logo và link các trang (Dashboard, Test Cases, History, Settings).
- **Top Header**: Hiện Breadcrumbs, Thanh tìm kiếm toàn cục, Nút tạo Test Case nhanh (Quick Add) và Profile.
- **Main Content Area**: Nơi chứa danh sách lưới (Grid / Cards) hoặc danh sách bảng (Tables) tùy vào view hiện tại.

---
*(Tài liệu này sẽ được bổ sung tiếp trong quá trình cài đặt UI Dashboard).*
