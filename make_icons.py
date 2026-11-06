"""Tạo logo cho extension từ một ảnh bất kỳ.

Cách dùng:   python make_icons.py "D:\\duong-dan\\anh.png"
Tùy chọn:    --cx 0.57 --cy 0.40 --size 0.70   (tâm cắt và cỡ cắt, tính theo tỉ lệ của ảnh; mặc định lấy khuôn mặt hơi lệch phải)

Việc làm: cắt ảnh vuông, thu nhỏ thành 16, 32, 48, 128 px, lưu vào thư mục icons của
  D:\\muse_extension  và  D:\\tool muse\\extension, rồi ghi "icons" và "action" vào hai file manifest.json.
Sau đó vào chrome://extensions bấm Reload extension là logo đổi.
"""
import argparse
import io
import json
import os
import sys

from PIL import Image

TARGETS = [r"D:\muse_extension", os.path.join(os.path.dirname(os.path.abspath(__file__)), "extension")]
SIZES = (16, 32, 48, 128)


def square_crop(img, cx, cy, size):
    w, h = img.size
    side = int(min(w, h) * size)
    side = max(16, min(side, min(w, h)))
    left = int(w * cx - side / 2)
    top = int(h * cy - side / 2)
    left = max(0, min(left, w - side))
    top = max(0, min(top, h - side))
    return img.crop((left, top, left + side, top + side))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--cx", type=float, default=0.57)
    ap.add_argument("--cy", type=float, default=0.40)
    ap.add_argument("--size", type=float, default=1.0)
    a = ap.parse_args()
    img = Image.open(a.image).convert("RGBA")
    sq = square_crop(img, a.cx, a.cy, a.size)
    for root in TARGETS:
        if not os.path.isdir(root):
            continue
        out = os.path.join(root, "icons")
        os.makedirs(out, exist_ok=True)
        for n in SIZES:
            sq.resize((n, n), Image.LANCZOS).save(os.path.join(out, "icon%d.png" % n))
        mp = os.path.join(root, "manifest.json")
        m = json.load(io.open(mp, encoding="utf-8"))
        files = {str(n): "icons/icon%d.png" % n for n in SIZES}
        m["icons"] = files
        m["action"] = {"default_title": "Triều Đình Muse", "default_icon": files}
        io.open(mp, "w", encoding="utf-8").write(json.dumps(m, ensure_ascii=False, indent=2))
        print("Đã tạo logo trong", out)
    print("Xong. Vào chrome://extensions bấm Reload extension.")


if __name__ == "__main__":
    sys.exit(main())
