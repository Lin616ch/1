"""Real YOLOv8 backbone for the dual-stream detector.

Loads a YOLOv8 (OBB) checkpoint, keeps the first 10 backbone layers and exposes
the four pyramid levels needed by the dual-stream skeleton:

    layer 2  -> P2 / stride 4   (yolov8n: 32 ch)
    layer 4  -> P3 / stride 8   (yolov8n: 64 ch)
    layer 6  -> P4 / stride 16  (yolov8n: 128 ch)
    layer 9  -> P5 / stride 32  (yolov8n: 256 ch, SPPF output)

The public contract matches the old `_DummyBackbone`:
    forward(x) -> {2: P2, 3: P3, 4: P4, 5: P5}
    .out_channels -> {2: C2, 3: C3, 4: C4, 5: C5}

Two independent instances (one per modality) are expected; nothing is shared.

Typical use
-----------
>>> bb = YOLOv8Backbone("weights/baseline_obb/yolov8n-obb-initial.pt")
>>> bb(torch.randn(1, 3, 640, 640))[2].shape
torch.Size([1, 32, 160, 160])

Single-channel thermal input is supported by `in_ch=1`: the pretrained first
3x3 conv is folded into a 1-channel conv (sum over input channels), which keeps
the pretrained response roughly the same magnitude as a grey-level image.
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional

import torch
import torch.nn as nn

#: Number of YOLOv8 layers that make up the backbone (0..9, SPPF included).
BACKBONE_DEPTH = 10

#: Layer index -> pyramid level.
FEATURE_LAYERS: Dict[int, int] = {2: 2, 4: 3, 6: 4, 9: 5}

#: Expected channels for the yolov8n scale (used for a friendly sanity check).
YOLOV8N_CHANNELS = {2: 32, 3: 64, 4: 128, 5: 256}

DEFAULT_WEIGHTS = Path(__file__).resolve().parents[2] / "weights" / "baseline_obb" / "yolov8n-obb-initial.pt"


def _torch_load(path: Path):
    """torch.load with the newer `weights_only` default handled explicitly."""
    try:
        return torch.load(path, map_location="cpu", weights_only=False)
    except TypeError:  # torch < 2.0 has no weights_only argument
        return torch.load(path, map_location="cpu")


def load_yolov8_model(weights: str | Path):
    """Load a YOLOv8 checkpoint and return the ultralytics model object.

    Accepts the usual ultralytics checkpoint dict ({"model": DetectionModel, ...})
    as well as a bare nn.Module from a stripped checkpoint.
    """
    path = Path(weights)
    if not path.is_file():
        raise FileNotFoundError(f"YOLOv8 weights not found: {path}")
    ckpt = _torch_load(path)
    if isinstance(ckpt, nn.Module):
        return ckpt
    if isinstance(ckpt, dict):
        model = ckpt.get("model", ckpt.get("ema"))
        if isinstance(model, nn.Module):
            return model
    raise TypeError(f"Unsupported checkpoint format in {path} (expected an ultralytics .pt)")


def _first_conv_block(module: nn.Module) -> Optional[nn.Module]:
    """Return the backbone's first block that owns an nn.Conv2d."""
    for layer in module.modules():
        if isinstance(layer, nn.Conv2d):
            return layer
        inner = getattr(layer, "conv", None)
        if isinstance(inner, nn.Conv2d):
            return layer
    return None


def adapt_conv_to_in_channels(block: nn.Module, in_ch: int) -> None:
    """In-place: turn a pretrained 3-channel conv block into an `in_ch`-channel one.

    For in_ch == 1 the weights are summed over the input channel axis, so the
    response to a grey image matches the original 3-channel response to the
    same grey value replicated three times. `block` must be an ultralytics
    Conv block (it owns `.conv`); bare nn.Conv2d cannot be replaced in place.
    """
    conv = block if isinstance(block, nn.Conv2d) else getattr(block, "conv", None)
    if not isinstance(conv, nn.Conv2d):
        raise TypeError(f"Cannot adapt {type(block)!r}: no nn.Conv2d found")
    if conv.in_channels == in_ch:
        return
    if conv.in_channels != 3:
        raise ValueError(f"Expected a 3-channel pretrained conv, got {conv.in_channels}")

    new = nn.Conv2d(
        in_ch,
        conv.out_channels,
        conv.kernel_size,
        conv.stride,
        conv.padding,
        dilation=conv.dilation,
        groups=conv.groups,
        bias=conv.bias is not None,
        padding_mode=conv.padding_mode,
    )
    with torch.no_grad():
        if in_ch == 1:
            new.weight.copy_(conv.weight.sum(dim=1, keepdim=True))
        else:
            repeat = (in_ch + 2) // 3
            w = conv.weight.repeat(1, repeat, 1, 1)[:, :in_ch]
            new.weight.copy_(w / repeat * 3)
        if conv.bias is not None:
            new.bias.copy_(conv.bias)

    if isinstance(block, nn.Conv2d):
        raise TypeError("Pass the ultralytics Conv block (with .conv), not a bare nn.Conv2d")
    block.conv = new


class YOLOv8Backbone(nn.Module):
    """YOLOv8 layers 0-9 with P2/P3/P4/P5 feature taps.

    Args:
        weights: path to a YOLOv8(.pt) checkpoint, usually a YOLOv8n-OBB baseline.
        in_ch: input channels (3 for RGB, 3 for replicated thermal, 1 for raw IR).
        depth: number of layers to keep (10 = through SPPF).
        verbose: print the channel/shape summary on construction.
    """

    def __init__(
        self,
        weights: str | Path = DEFAULT_WEIGHTS,
        in_ch: int = 3,
        depth: int = BACKBONE_DEPTH,
        verbose: bool = False,
    ):
        super().__init__()
        if depth < max(FEATURE_LAYERS) + 1:
            raise ValueError(f"depth={depth} is too small; need at least {max(FEATURE_LAYERS) + 1}")

        model = load_yolov8_model(weights)
        layers = list(model.model.children())[:depth]
        # The exported checkpoint stores fp16 weights; train the dual-stream net in fp32.
        self.layers = nn.Sequential(*layers).float()
        self.depth = depth
        self.in_ch = in_ch
        self.weights_path = str(weights)

        # Optional single-channel adaptation of the first conv.
        if in_ch != 3:
            first = _first_conv_block(self.layers[0])
            if first is None:
                raise RuntimeError("Could not locate the first conv in the YOLOv8 backbone")
            adapt_conv_to_in_channels(first, in_ch)

        # Infer the tap channels from a tiny dummy forward (robust to scale changes).
        self.out_channels = self._infer_channels(in_ch)
        if verbose:
            print(f"YOLOv8Backbone: first {depth} layers from {Path(weights).name}, in_ch={in_ch}")
            for level, ch in self.out_channels.items():
                stride = 2 ** level
                print(f"  P{level}: {ch:4d} ch @ stride {stride:2d}")

    # -- helpers -------------------------------------------------------------
    def _infer_channels(self, in_ch: int) -> Dict[int, int]:
        was_training = self.training
        self.eval()
        with torch.no_grad():
            feats = self.forward(torch.zeros(2, in_ch, 64, 64))
        self.train(was_training)
        return {level: f.shape[1] for level, f in feats.items()}

    # -- forward -------------------------------------------------------------
    def forward(self, x: torch.Tensor) -> Dict[int, torch.Tensor]:
        feats: Dict[int, torch.Tensor] = {}
        for idx, layer in enumerate(self.layers):
            x = layer(x)
            level = FEATURE_LAYERS.get(idx)
            if level is not None:
                feats[level] = x
        return feats

    def extra_repr(self) -> str:
        taps = ", ".join(f"P{l}={c}" for l, c in self.out_channels.items())
        return f"weights={Path(self.weights_path).name}, in_ch={self.in_ch}, {taps}"


def build_yolov8_backbone(
    weights: str | Path = DEFAULT_WEIGHTS,
    in_ch: int = 3,
    verbose: bool = False,
) -> YOLOv8Backbone:
    """Factory used by the dual-stream skeleton (one call per modality)."""
    return YOLOv8Backbone(weights=weights, in_ch=in_ch, verbose=verbose)


if __name__ == "__main__":
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_WEIGHTS
    bb = build_yolov8_backbone(path, verbose=True).eval()
    with torch.no_grad():
        out = bb(torch.randn(1, 3, 640, 640))
    for level, feat in out.items():
        print(f"P{level}: {tuple(feat.shape)}")
