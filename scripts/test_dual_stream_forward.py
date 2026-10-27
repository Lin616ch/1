"""End-to-end random-data forward test for the dual-stream detector.

Builds DualStreamDetector with two independent YOLOv8 backbones (P2-P5),
runs a 6-channel input (RGB | thermal) as well as the two-argument form,
in both eval and train modes, and asserts every output shape.

Run from the repo root:
    .venv\\Scripts\\python.exe scripts\\test_dual_stream_forward.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import torch

# Import the editable install before the repo root lands on sys.path (otherwise
# the repo's `ultralytics/` source folder shadows it as a namespace package).
import ultralytics  # noqa: F401,E402

ROOT = Path(__file__).resolve().parents[1]
# Append (not prepend) so the editable `ultralytics` install wins over the
# repo-root `ultralytics/` source folder.
sys.path.append(str(ROOT))

from src.models.dual_stream_yolo import DualStreamDetector  # noqa: E402

OUT_DIR = ROOT / "experiments" / "w2_yolov8_backbone"
EXPECTED_FEATS = {2: (1, 32, 160, 160), 3: (1, 64, 80, 80), 4: (1, 128, 40, 40), 5: (1, 256, 20, 20)}


def describe(model: DualStreamDetector, batch: int = 1):
    rgb = model.backbone.rgb
    th = model.backbone.thermal
    print(f"backbone RGB    : {rgb.extra_repr()}")
    print(f"backbone thermal: {th.extra_repr()}")
    shared = {id(p) for p in rgb.parameters()} & {id(p) for p in th.parameters()}
    print(f"shared tensors  : {len(shared)} (expect 0)")
    assert not shared

    total = sum(p.numel() for p in model.parameters())
    print(f"detector params : {total:,}")


def main():
    torch.manual_seed(0)
    model = DualStreamDetector(num_classes=5, use_tiny_p2=True, aux_illum=True)
    describe(model)

    # --- eval, 6-channel tensor -------------------------------------------
    model.eval()
    x = torch.randn(1, 6, 640, 640)
    t0 = time.perf_counter()
    with torch.no_grad():
        out = model(x)
    dt = (time.perf_counter() - t0) * 1000

    print(f"\n[eval] input {tuple(x.shape)}  forward {dt:.0f} ms")
    print(f"  gates: " + ", ".join(f"P{l}{tuple(g.shape)}" for l, g in out["gates"].items()))
    print("  preds:")
    for level, pred in zip((2, 3, 4, 5), out["preds"]):
        print(f"    P{level}: {tuple(pred.shape)}")
        assert pred.shape[0] == 1 and pred.shape[1] == 9, f"unexpected head output {tuple(pred.shape)}"
    assert sorted(out) == ["gates", "preds"], sorted(out)

    # --- eval, two-argument form ------------------------------------------
    with torch.no_grad():
        out2 = model(torch.randn(1, 3, 640, 640), torch.randn(1, 3, 640, 640))
    print(f"\n[eval] forward(rgb, thermal) -> {[tuple(p.shape) for p in out2['preds']]}")

    # --- train mode (modality dropout + auxiliary heads) -------------------
    model.train()
    xb = torch.randn(2, 6, 640, 640)
    out3 = model(xb)
    print(f"\n[train] input {tuple(xb.shape)}")
    print("  preds:", [tuple(p.shape) for p in out3["preds"]])
    print("  aux_rgb:", [tuple(p.shape) for p in out3["aux_rgb"]])
    print("  illum:", tuple(out3["illum"].shape))
    assert sorted(out3) == ["aux_rgb", "aux_th", "gates", "illum", "preds"]

    # --- verify the P2-P5 feature maps themselves -------------------------
    model.eval()
    with torch.no_grad():
        f_rgb, f_th = model.backbone(torch.randn(1, 3, 640, 640), torch.randn(1, 3, 640, 640))
    print("\nbackbone taps (batch=1, 640x640):")
    for level in (2, 3, 4, 5):
        sr, st = tuple(f_rgb[level].shape), tuple(f_th[level].shape)
        print(f"  P{level}: RGB {str(sr):22s} IR {str(st):22s}")
        assert sr == EXPECTED_FEATS[level], (level, sr)
        assert st == EXPECTED_FEATS[level], (level, st)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "ultralytics": __import__("ultralytics").__version__,
        "torch": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "device": "cpu",
        "input": list(x.shape),
        "features": {f"P{k}": list(v) for k, v in EXPECTED_FEATS.items()},
        "preds": [list(p.shape) for p in out["preds"]],
        "gates": {f"P{k}": list(v.shape) for k, v in out["gates"].items()},
        "params": sum(p.numel() for p in model.parameters()),
        "forward_ms_cpu": round(dt, 1),
    }
    (OUT_DIR / "forward_test.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    print(f"\nwrote {OUT_DIR / 'forward_test.json'}")
    print("\nALL END-TO-END CHECKS PASSED")


if __name__ == "__main__":
    main()
