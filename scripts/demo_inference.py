"""Minimal real-image inference demo for the dual-stream YOLOv8 skeleton.

Loads the real YOLOv8n-OBB backbone, runs one RGB photo + a pseudo-thermal
(grayscale, replicated to 3 channels, since no paired IR is available) through
both streams, and saves:

    demo/input_pair.png    letterboxed RGB | pseudo-IR
    demo/features.png      P2-P5 activation maps: RGB backbone vs QAFM-fused
    demo/result.json       shapes, gate weights, timings

The detection head is still a placeholder, so no boxes are drawn; this demo
verifies the *feature pipeline* on real pixels.

Run from the repo root:
    .venv\\Scripts\\python.exe scripts\\demo_inference.py --image <photo.jpg>
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch

# Import the editable install before the repo root lands on sys.path.
import ultralytics  # noqa: F401,E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from src.models.dual_stream_yolo import DualStreamDetector  # noqa: E402

OUT_DIR = ROOT / "experiments" / "w2_yolov8_backbone" / "demo"
DEFAULT_IMAGE = Path(r"C:\Windows\Web\Wallpaper\ThemeC\img29.jpg")


def letterbox(img: np.ndarray, size: int = 640) -> tuple[np.ndarray, float, tuple[int, int]]:
    """Resize keeping aspect ratio, pad to square with gray (114)."""
    h, w = img.shape[:2]
    scale = size / max(h, w)
    nh, nw = int(round(h * scale)), int(round(w * scale))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    top, left = (size - nh) // 2, (size - nw) // 2
    canvas[top:top + nh, left:left + nw] = resized
    return canvas, scale, (left, top)


def to_tensor(rgb: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(rgb).permute(2, 0, 1).float().unsqueeze(0) / 255.0


def save_overview(rgb: np.ndarray, thermal: np.ndarray, out_path: Path):
    gap = np.full((rgb.shape[0], 12, 3), 255, dtype=np.uint8)
    cv2.imwrite(str(out_path), cv2.cvtColor(np.hstack([rgb, gap, thermal]), cv2.COLOR_RGB2BGR))
    print(f"wrote {out_path}")


def save_feature_grid(f_rgb, fused, out_path: Path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
    plt.rcParams["axes.unicode_minus"] = False

    levels = [2, 3, 4, 5]
    fig, axes = plt.subplots(2, 4, figsize=(13.5, 6.4), dpi=190)
    fig.suptitle("真实图片前向：RGB 主干特征（上）与 QAFM 融合特征（下）", fontsize=15, fontweight="bold")

    for col, level in enumerate(levels):
        for row, (feats, tag) in enumerate(((f_rgb, "RGB"), (fused, "融合"))):
            f = feats[level][0]
            act = f.mean(dim=0).cpu().numpy()
            ax = axes[row, col]
            im = ax.imshow(act, cmap="inferno")
            ax.set_title(f"P{level} {tag}\n{tuple(f.shape)}", fontsize=10)
            ax.axis("off")
            fig.colorbar(im, ax=ax, fraction=0.046, pad=0.02)
            # contour overlay at a high quantile to make structures visible
            thr = np.quantile(act, 0.93)
            ax.contour(act, levels=[thr], colors="white", linewidths=0.6, alpha=0.7)

    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(out_path, facecolor="white")
    plt.close(fig)
    print(f"wrote {out_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", type=Path, default=DEFAULT_IMAGE)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    bgr = cv2.imread(str(args.image))
    if bgr is None:
        raise SystemExit(f"cannot read image: {args.image}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    print(f"input: {args.image}  shape={rgb.shape}")

    rgb640, scale, (pad_x, pad_y) = letterbox(rgb, 640)
    # Pseudo-thermal: no paired IR available, so use luminance replicated to 3 ch.
    gray = cv2.cvtColor(rgb640, cv2.COLOR_RGB2GRAY)
    thermal640 = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)

    save_overview(rgb640, thermal640, out_dir / "input_pair.png")

    model = DualStreamDetector(num_classes=5, use_tiny_p2=True, aux_stream_heads=False).eval()
    rgb_t, th_t = to_tensor(rgb640), to_tensor(thermal640)

    t0 = time.perf_counter()
    with torch.no_grad():
        # public API: 6-channel input, exactly how the trainer feeds it
        out = model(torch.cat([rgb_t, th_t], dim=1))
        # internals for visualisation
        f_rgb, f_th = model.backbone(rgb_t, th_t)
        fused, gates = {}, {}
        for level in model.levels:
            fused[level], gates[level] = model.fusions[str(level)](f_rgb[level], f_th[level])
    dt = (time.perf_counter() - t0) * 1000

    print(f"\nforward: {dt:.0f} ms (CPU)")
    for level in model.levels:
        print(f"  P{level}: RGB {tuple(f_rgb[level].shape)}  "
              f"IR {tuple(f_th[level].shape)}  fused {tuple(fused[level].shape)}  "
              f"gate {tuple(gates[level].shape)} -> {gates[level].tolist()}")
    print("  preds:", [tuple(p.shape) for p in out["preds"]])

    save_feature_grid(f_rgb, fused, out_dir / "features.png")

    record = {
        "image": str(args.image),
        "image_shape": list(rgb.shape),
        "letterbox_scale": round(scale, 4),
        "padding_xy": [pad_x, pad_y],
        "thermal_source": "pseudo-IR = luminance replicated to 3 channels (no paired IR)",
        "device": "cpu",
        "torch": torch.__version__,
        "ultralytics": ultralytics.__version__,
        "forward_ms": round(dt, 1),
        "features": {
            f"P{k}": {
                "rgb": list(f_rgb[k].shape),
                "thermal": list(f_th[k].shape),
                "fused": list(fused[k].shape),
                "gate": [round(v, 4) for v in gates[k][0].tolist()],
            }
            for k in model.levels
        },
        "head_outputs": [list(p.shape) for p in out["preds"]],
        "note": "detection head is still a placeholder (_DummyHead); no boxes are meaningful yet",
    }
    (out_dir / "result.json").write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out_dir / 'result.json'}")
    print("\nDEMO OK")


if __name__ == "__main__":
    main()
