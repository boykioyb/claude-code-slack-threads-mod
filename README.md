# slack-threads — panel theo dõi thread Slack cho Claude Code

Mod cho Claude Code (Claude Desktop hoặc terminal): một panel để theo dõi các thread Slack bằng link, đọc chúng gần
giống như trong Slack, dịch bằng AI và trả lời, qua connector Slack có sẵn trong Claude. Mod không giữ token nào.

## Có gì

- **Theo dõi bằng link:** dán permalink một tin trong thread (Copy link trong Slack). Danh sách cho biết thread nào
  có tin mới; panel tự làm mới thread đang mở mỗi 30 giây, và vài thread khác mỗi khoảng 2 phút.
- **Đọc như Slack:** tên người thay cho id, mention, link, chữ đậm, gạch ngang, xuống dòng giữ nguyên, file đính kèm,
  reaction (cả màu da). Mở thread thấy tin gốc và 5 trả lời mới nhất; nút **Xem 5 tin cũ hơn** tải dần phần trước.
- **Dịch:** công tắc **Bản gốc | Bản dịch** cho cả thread, dịch song song vài tin một lúc. Bản dịch được lưu lại, mở
  lại hoặc khởi động lại không phải dịch lại; tin bị sửa trên Slack thì dịch lại tin đó.
- **Cài đặt dịch:** chọn model (Haiku / Sonnet / Opus), phong cách (Chính xác / Cân bằng / Sáng tạo) và ngôn ngữ
  (Tiếng Việt / English / 日本語).
- **Nhật ký AI:** từng bước của mỗi lần dịch, kèm thời gian và số token.
- **Copy:** tin nhắn, bản dịch, link tin, link thread.
- **Tải file đính kèm** về thư mục Downloads (connector đọc được file tới 10 MB).
- **Trả lời:** viết, xem lại rồi mới gửi; `@Tên` của người trong thread thành mention; tuỳ chọn gửi cả vào kênh.
- **Đổi tên thread** trong danh sách cho dễ nhận ra.
- **Tool cho model:** `slack_thread_read` đọc thread đang mở, `slack_thread_draft` đưa bản nháp trả lời vào ô soạn.
  Model không bao giờ tự gửi: bạn xem lại và gửi từ panel.

## Cần có

- Claude Code trên **Claude Desktop** hoặc **terminal**. App mobile chưa dùng được (chưa có ô nhập).
- **Connector Slack** của Claude đã bật trong phiên: **+** cạnh ô nhập → **Connectors** → Slack. Mod tự tìm connector
  qua tên tool `slack_read_thread`, nên không cần cấu hình gì thêm.
- Để tải file nhị phân (ảnh, PDF…): lệnh `base64` trên macOS / Linux, PowerShell trên Windows (có sẵn).

## Cài

Trong một phiên Claude Code ở terminal:

```
/plugin install slack-threads --marketplace boykioyb/claude-code-slack-threads-mod
```

Trả lời `y` để thêm marketplace, rồi chọn phạm vi (user). Hoặc từ shell:

```bash
claude plugin install slack-threads --marketplace boykioyb/claude-code-slack-threads-mod
```

Trên Claude Desktop: bấm **+** cạnh ô nhập → **Plugins** → **Add marketplace** với
`boykioyb/claude-code-slack-threads-mod` → **Add plugin**.

Mở panel bằng lệnh `/slack-threads`.

## Cấp quyền cho connector Slack

Mod gọi tool của connector Slack từ panel, không qua một lượt chat. Ở chế độ quyền **auto**, bộ phân loại quyền có thể
không quyết được cho kiểu gọi này và chặn; panel khi đó báo lỗi kèm tên tool, dạng
`mcp__<tên server>__slack_read_thread`.

Sửa bằng quy tắc cho phép sẵn trong file cài đặt của Claude Code (`~/.claude/settings.json`; Windows:
`%USERPROFILE%\.claude\settings.json`), lấy đúng `<tên server>` trong thông báo lỗi:

```json
{
  "permissions": {
    "allow": [
      "mcp__<tên server>__slack_read_thread",
      "mcp__<tên server>__slack_read_file",
      "mcp__<tên server>__slack_send_message"
    ]
  }
}
```

Hai quy tắc đầu chỉ đọc. Bỏ dòng `slack_send_message` nếu muốn mỗi lần gửi trả lời vẫn hỏi bạn. Nếu đã có
`"allow": [ … ]` thì chỉ thêm các dòng trên vào mảng đó. Lưu file rồi khởi động lại Claude.

## Cập nhật

Xem phiên bản đang cài ở **+ → Plugins**, so với `version` trong
[`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) của repo.

**Claude Code ở terminal:**

```bash
claude plugin marketplace update claude-code-slack-threads-mod
```

```bash
claude plugin update slack-threads@claude-code-slack-threads-mod
```

Rồi khởi động lại phiên.

**Claude Desktop:** app giữ một bản clone của repo và **không tự kéo bản mới**; gỡ rồi cài lại vẫn chép từ bản clone cũ.
Cập nhật bản clone bằng git:

1. Thoát hẳn Claude Desktop (cả biểu tượng ở khay hệ thống / thanh menu), để app không giữ file.
2. Kéo bản clone lên `main` mới nhất và xem phiên bản.

   Windows (PowerShell):

   ```powershell
   $m = "$env:USERPROFILE/.claude/plugins/marketplaces/claude-code-slack-threads-mod"; git -C $m fetch origin; git -C $m reset --hard origin/main; Select-String '"version"' "$m/.claude-plugin/plugin.json"
   ```

   macOS / Linux:

   ```bash
   m=~/.claude/plugins/marketplaces/claude-code-slack-threads-mod; git -C $m fetch origin && git -C $m reset --hard origin/main && grep '"version"' $m/.claude-plugin/plugin.json
   ```

3. Xoá bản chép của phiên bản cũ trong `~/.claude/plugins/cache/claude-code-slack-threads-mod/slack-threads/`
   (Windows: `$env:USERPROFILE/.claude/plugins/cache/claude-code-slack-threads-mod/slack-threads/`).
4. Mở lại app → **+ → Plugins** → cài hoặc bật **slack-threads**, kiểm phiên bản mới, rồi mở một phiên mới.

Đường dẫn trong lệnh dùng dấu `/` (PowerShell nhận được): copy từ một số khung chat, `\.` có thể mất dấu `\` và lệnh
báo không tìm thấy thư mục.

## Dữ liệu và quyền riêng tư

- Danh sách thread theo dõi nằm trên máy: `~/.local/share/slack-threads/threads.json`.
- Bản dịch và cài đặt dịch nằm trong kho riêng của mod trong thư mục cấu hình Claude Code (giữ 20 thread dùng gần
  nhất).
- Mod không giữ token nào; mọi lệnh tới Slack đi qua connector Slack của Claude, bằng tài khoản bạn đã kết nối.
- Khi dịch, nội dung từng tin được gửi cho model Claude bạn chọn trong Cài đặt.
