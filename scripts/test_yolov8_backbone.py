"""Single-stream self-test for the real YOLOv8 backbone.

Verifies the P2/P3/P4/P5 shapes required by the dual-stream skeleton:

    P2 (1, 32, 160, 160)
    P3 (1, 64,  80,  80)
    P4 (1, 128, 40,  40)
    P5 (1, 256, 20,  20)

Run from the repo root:
    .venv\\Scripts\\python.exe scripts\\test_yolov8_backbone.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import torch

# Import the editable install before the repo root lands on sys.path: the repo's
# `ultralytics/` source folder would otherwise be picked up as a namespace package.
import ultralytics  # noqa: F401,E402

ROOT = Path(__file__).resolve().parents[1]
# Append (not prepend): keep site-packages' editable `ultralytics` ahead of the
# repo-root `ultralytics/` source folder, which would otherwise shadow it.
sys.path.append(str(ROOT))

from src.models.yolov8_backbone import DEFAULT_WEIGHTS, YOLOv8Backbone  # noqa: E402

EXPECTED = {2: (1, 32, 160, 160), 3: (1, 64, 80, 80), 4: (1, 128, 40, 40), 5: (1, 256, 20, 20)}


def check(tag: str, backbone: YOLOv8Backbone, in_ch: int, batch: int = 1):
    backbone.eval()
    x = torch.randn(batch, in_ch, 640, 640)
    with torch.no_grad():
        feats = backbone(x)
    print(f"\n[{tag}] input {tuple(x.shape)}")
    for level in sorted(feats):
        shape = tuple(feats[level].shape)
        expected = (batch,) + EXPECTED[level][1:]
        ok = shape == expected
        print(f"  P{level}: {str(shape):28s} expected {str(expected):28s} {'OK' if ok else 'MISMATCH'}")
        assert ok, f"{tag}: P{level} got {shape}, expected {expected}"
    return feats


def main():
    print(f"weights: {DEFAULT_WEIGHTS}")
    print(f"exists : {Path(DEFAULT_WEIGHTS).is_file()}")

    rgb = YOLOv8Backbone(DEFAULT_WEIGHTS, in_ch=3, verbose=True)
    check("RGB 3ch", rgb, in_ch=3)
    check("RGB 3ch batch=2", rgb, in_ch=3, batch=2)

    # The current dataloader already returns a 3-channel IR image, so the thermal
    # stream reuses the same 3-channel stem (just a different weight instance).
    thermal = YOLOv8Backbone(DEFAULT_WEIGHTS, in_ch=3, verbose=False)
    check("Thermal 3ch (replicated)", thermal, in_ch=3)

    # Optional: true single-channel IR; folds the pretrained first conv to 1 input channel.
    thermal_1ch = YOLOv8Backbone(DEFAULT_WEIGHTS, in_ch=1, verbose=False)
    check("Thermal 1ch (folded conv)", thermal_1ch, in_ch=1)
    first_conv = thermal_1ch.layers[0].conv
    print(f"\n  first conv in_channels = {first_conv.in_channels} (expect 1)")
    assert first_conv.in_channels == 1

    # Two streams must be fully independent: no shared parameters.
    ids_rgb = {id(p) for p in rgb.parameters()}
    ids_th = {id(p) for p in thermal.parameters()}
    print(f"\n  shared tensors between RGB/thermal backbones: {len(ids_rgb & ids_th)} (expect 0)")
    assert not (ids_rgb & ids_th)

    n_params = sum(p.numel() for p in rgb.parameters())
    print(f"  backbone parameters (RGB): {n_params:,}")
    print("\nALL SINGLE-STREAM CHECKS PASSED")


if __name__ == "__main__":
    main()
