"""Generate report figures: architecture diagram + terminal screenshots.

Outputs (under experiments/w2_yolov8_backbone/figures/):
    architecture.png    dual-stream YOLOv8 skeleton with feature shapes
    backbone_selftest.png  terminal screenshot of scripts/test_yolov8_backbone.py
    dual_forward.png    terminal screenshot of scripts/test_dual_stream_forward.py

Run from the repo root:
    .venv\\Scripts\\python.exe scripts\\make_report_figures.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "experiments" / "w2_yolov8_backbone" / "figures"
OUT.mkdir(parents=True, exist_ok=True)

FONT_MONO = Path("C:/Windows/Fonts/consola.ttf")
FONT_CJK = Path("C:/Windows/Fonts/msyh.ttc")


# --------------------------------------------------------------------------
# Terminal screenshots
# --------------------------------------------------------------------------
def render_terminal(log_path: Path, out_path: Path, title: str, font_size: int = 16):
    raw = log_path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):  # PowerShell Tee-Object writes UTF-16
        text = raw.decode("utf-16")
    else:
        text = raw.decode("utf-8-sig")
    text = text.replace("\t", "    ").rstrip("\n")
    lines = text.splitlines()
    font = ImageFont.truetype(str(FONT_MONO), font_size)
    bold = ImageFont.truetype(str(FONT_MONO), font_size)

    pad, line_h = 28, font_size + 9
    char_w = font.getlength("M")
    width = int(max(max(font.getlength(ln) for ln in lines), font.getlength(title)) + pad * 2)
    width = max(width, 980)
    header_h = 46
    height = header_h + pad + line_h * len(lines) + pad

    img = Image.new("RGB", (width, height), "#1e1e2e")
    d = ImageDraw.Draw(img)

    # title bar
    d.rectangle([0, 0, width, header_h], fill="#313244")
    for i, color in enumerate(("#f38ba8", "#f9e2af", "#a6e3a1")):
        d.ellipse([16 + i * 22, 16, 28 + i * 22, 28], fill=color)
    d.text((92, 13), title, font=bold, fill="#cdd6f4")

    y = header_h + pad - 6
    for ln in lines:
        if ln.startswith("===") or "PASSED" in ln or "OK" in ln.split()[-1:]:
            color = "#a6e3a1"
        elif "MISMATCH" in ln or "Error" in ln or "Traceback" in ln:
            color = "#f38ba8"
        elif ln.strip().startswith("P") and "(" in ln:
            color = "#89b4fa"
        elif ln.startswith("[") or ln.startswith("  P"):
            color = "#f9e2af"
        else:
            color = "#cdd6f4"
        d.text((pad, y), ln, font=font, fill=color)
        y += line_h

    img.save(out_path)
    print(f"wrote {out_path}  ({img.width}x{img.height})")


# --------------------------------------------------------------------------
# Architecture diagram
# --------------------------------------------------------------------------
def render_architecture(out_path: Path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
    plt.rcParams["axes.unicode_minus"] = False

    fig, ax = plt.subplots(figsize=(14.5, 7.6), dpi=220)
    ax.set_xlim(0, 14.5)
    ax.set_ylim(0, 7.6)
    ax.axis("off")

    def box(x, y, w, h, label, fc, ec, fs=11, bold=False):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.06,rounding_size=0.12",
                                    linewidth=1.6, edgecolor=ec, facecolor=fc))
        ax.text(x + w / 2, y + h / 2, label, ha="center", va="center", fontsize=fs,
                fontweight="bold" if bold else "normal", color="#1f2430", linespacing=1.45)

    def arrow(x1, y1, x2, y2, color="#6c7086", lw=1.8):
        ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=14,
                                     color=color, linewidth=lw, connectionstyle="arc3,rad=0"))

    ax.text(7.25, 7.2, "双流 YOLOv8 骨架：RGB / 红外 两路独立 backbone（P2–P5）",
            ha="center", fontsize=17.5, fontweight="bold", color="#11111b")
    ax.text(7.25, 6.82, "YOLOv8n-OBB 前 10 层（0–9，含 SPPF）· 输入 640×640 · 两路参数零共享",
            ha="center", fontsize=10.5, color="#45475a")

    feat_text = ("P2  32 × 160 × 160\n"
                 "P3  64 ×  80 ×  80\n"
                 "P4 128 ×  40 ×  40\n"
                 "P5 256 ×  20 ×  20")

    # --- RGB lane ---------------------------------------------------------
    lane_rgb, lane_ir = 4.95, 2.45
    box(0.3, lane_rgb, 1.95, 1.0, "RGB 输入\n(1, 3, 640, 640)", "#dbeafe", "#2563eb")
    box(2.75, lane_rgb, 2.75, 1.0, "YOLOv8 Backbone · RGB\nLayer 0–9（独立实例 #1）", "#eff6ff", "#2563eb", 10.5)
    box(6.0, lane_rgb - 0.28, 3.05, 1.56, feat_text, "#eef2ff", "#4f46e5", 10)

    # --- IR lane ----------------------------------------------------------
    box(0.3, lane_ir, 1.95, 1.0, "红外输入\n(1, 3, 640, 640)", "#fee2e2", "#dc2626")
    box(2.75, lane_ir, 2.75, 1.0, "YOLOv8 Backbone · 红外\nLayer 0–9（独立实例 #2）", "#fef2f2", "#dc2626", 10.5)
    box(6.0, lane_ir - 0.28, 3.05, 1.56, feat_text, "#fef2f2", "#dc2626", 10)

    arrow(2.25, lane_rgb + 0.5, 2.75, lane_rgb + 0.5, "#2563eb")
    arrow(2.25, lane_ir + 0.5, 2.75, lane_ir + 0.5, "#dc2626")
    arrow(5.5, lane_rgb + 0.5, 6.0, lane_rgb + 0.5, "#2563eb")
    arrow(5.5, lane_ir + 0.5, 6.0, lane_ir + 0.5, "#dc2626")

    # --- fusion -----------------------------------------------------------
    box(9.75, 2.9, 2.35, 2.85,
        "QAFM 融合\n\nP2 / P3 / P4 / P5\n逐层门控加权\n（每层 RGB + 红外）",
        "#f0fdf4", "#16a34a", 10.5)
    arrow(9.05, lane_rgb + 0.5, 9.75, 4.55, "#2563eb", 1.5)
    arrow(9.05, lane_ir + 0.5, 9.75, 4.1, "#dc2626", 1.5)

    # --- head -------------------------------------------------------------
    box(12.55, 2.65, 1.75, 3.35,
        "检测头（占位）\n\nP2 9×160×160\nP3 9×80×80\nP4 9×40×40\nP5 9×20×20",
        "#fefce8", "#ca8a04", 10)
    arrow(12.1, 4.3, 12.55, 4.3, "#6c7086", 1.6)

    ax.text(0.3, 1.55,
            "注：红外默认复制为 3 通道送入 3 通道 stem；in_ch=1 时把首层 3×3 卷积按输入通道求和折叠为单通道。\n"
            "P2/P3/P4/P5 分别取第 2/4/6/9 层输出，stride 4/8/16/32。",
            fontsize=9, color="#585b70", va="top", linespacing=1.6)

    fig.savefig(out_path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"wrote {out_path}")


def main():
    render_terminal(ROOT / "experiments/w2_yolov8_backbone/backbone_selftest.log",
                    OUT / "backbone_selftest.png",
                    r"$ .venv\Scripts\python.exe scripts\test_yolov8_backbone.py")
    render_terminal(ROOT / "experiments/w2_yolov8_backbone/dual_forward.log",
                    OUT / "dual_forward.png",
                    r"$ .venv\Scripts\python.exe scripts\test_dual_stream_forward.py")
    render_architecture(OUT / "architecture.png")


if __name__ == "__main__":
    main()
