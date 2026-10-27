"""Dual-stream (RGB + Thermal) detector skeleton, v2.

Changes vs v1
-------------
* Input interface: forward(x) takes a 6-channel tensor (RGB | thermal), so the
  standard ultralytics-style trainer can feed it. forward(rgb, thermal) still works.
* Pyramid levels are configurable: levels=(3, 4, 5) or (2, 3, 4, 5) for Tiny-P2.
  Backbones return {level: feature}; fusions are built per level.
* QAFMFusion = channel gate + spatial gate, zero-initialised (starts at 0.5/0.5).
  A `light` mode (spatial gate only) is used at P2 to save memory.
* Training helpers: modality dropout, optional per-stream auxiliary heads,
  optional day/night auxiliary head to give the gate a real "quality" signal.
* Fixes: `x is None` instead of `x or default`; thermal channel adaptation.

Output of forward() is a dict:
    {"preds": [...per level...], "gates": {level: (B, 2)},
     "aux_rgb": [...], "aux_th": [...], "illum": (B, 2)}   # aux keys only in training
An adapter is still needed to match ultralytics' loss / Detect output format.
"""
from typing import Dict, Optional, Sequence, Tuple

import torch
import torch.nn as nn

try:  # package import (src.models.dual_stream_yolo)
    from .yolov8_backbone import DEFAULT_WEIGHTS, YOLOv8Backbone
except ImportError:  # direct script execution
    from yolov8_backbone import DEFAULT_WEIGHTS, YOLOv8Backbone


# --------------------------------------------------------------------------
# Utilities
# --------------------------------------------------------------------------
def conv_bn_act(c_in: int, c_out: int, k: int = 3, s: int = 1) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(c_in, c_out, k, s, k // 2, bias=False),
        nn.BatchNorm2d(c_out),
        nn.SiLU(inplace=True),
    )


def adapt_first_conv_to_1ch(conv: nn.Conv2d) -> nn.Conv2d:
    """Turn a pretrained 3-channel first conv into a 1-channel one (sum over input channels).

    Use this when the thermal backbone should accept single-channel input but
    you still want to start from COCO-pretrained weights.
    """
    new = nn.Conv2d(1, conv.out_channels, conv.kernel_size, conv.stride,
                    conv.padding, bias=conv.bias is not None)
    with torch.no_grad():
        new.weight.copy_(conv.weight.sum(dim=1, keepdim=True))
        if conv.bias is not None:
            new.bias.copy_(conv.bias)
    return new


def modality_dropout(rgb: torch.Tensor, th: torch.Tensor, p: float):
    """Per sample, with total probability p, zero out ONE modality (half RGB, half thermal)."""
    if p <= 0:
        return rgb, th
    b = rgb.shape[0]
    r = torch.rand(b, device=rgb.device)
    drop_rgb = (r < p / 2).view(b, 1, 1, 1)
    drop_th = ((r >= p / 2) & (r < p)).view(b, 1, 1, 1)
    return rgb.masked_fill(drop_rgb, 0.0), th.masked_fill(drop_th, 0.0)


# --------------------------------------------------------------------------
# Backbone
# --------------------------------------------------------------------------
class DualStreamBackbone(nn.Module):
    """Two fully independent YOLOv8 backbones loaded from the same checkpoint.

    Each modality gets its own `YOLOv8Backbone` instance (layers 0-9, P2-P5
    taps). Nothing is shared: no module aliasing, no tied parameters. The
    thermal stream accepts either 3 replicated channels (`thermal_in_ch=3`) or
    a true single-channel IR input (`thermal_in_ch=1`, first conv folded).
    """

    def __init__(self, levels: Sequence[int] = (3, 4, 5),
                 rgb_backbone: Optional[nn.Module] = None,
                 thermal_backbone: Optional[nn.Module] = None,
                 thermal_in_ch: int = 3,
                 weights=DEFAULT_WEIGHTS,
                 verbose: bool = False):
        super().__init__()
        self.levels = tuple(levels)
        self.rgb = (rgb_backbone if rgb_backbone is not None
                    else YOLOv8Backbone(weights=weights, in_ch=3, verbose=verbose))
        self.thermal = (thermal_backbone if thermal_backbone is not None
                        else YOLOv8Backbone(weights=weights, in_ch=thermal_in_ch, verbose=verbose))
        if self.rgb is self.thermal:
            raise ValueError("RGB and thermal backbones must be two distinct instances")
        self.out_channels = {l: self.rgb.out_channels[l] for l in self.levels}

    def forward(self, rgb: torch.Tensor, thermal: torch.Tensor):
        f_r, f_t = self.rgb(rgb), self.thermal(thermal)
        return ({l: f_r[l] for l in self.levels},
                {l: f_t[l] for l in self.levels})


# --------------------------------------------------------------------------
# Quality-aware fusion
# --------------------------------------------------------------------------
class QAFMFusion(nn.Module):
    """Quality-Aware Fusion Module.

    logits = channel_logits (global, per channel) + spatial_logits (per pixel)
    weights = softmax over the two modalities; fused = w_rgb * f_rgb + w_th * f_th.

    Both gates end in a zero-initialised conv, so training starts from an
    equal 0.5 / 0.5 mix instead of a random bias toward one modality.
    `light=True` drops the channel gate (cheaper; intended for the P2 level).
    """

    def __init__(self, channels: int, reduction: int = 4, light: bool = False):
        super().__init__()
        self.channels, self.light = channels, light

        # spatial gate: per-pixel mean/max statistics of each modality -> 2 logits
        self.spatial_gate = nn.Conv2d(4, 2, kernel_size=7, padding=3)
        nn.init.zeros_(self.spatial_gate.weight)
        nn.init.zeros_(self.spatial_gate.bias)

        self.channel_gate = None
        if not light:
            hidden = max(channels // reduction, 8)
            last = nn.Conv2d(hidden, 2 * channels, 1)
            nn.init.zeros_(last.weight)
            nn.init.zeros_(last.bias)
            self.channel_gate = nn.Sequential(
                nn.AdaptiveAvgPool2d(1),
                nn.Conv2d(2 * channels, hidden, 1), nn.SiLU(inplace=True),
                last,
            )
        self.proj = conv_bn_act(channels, channels, k=1)

    def forward(self, f_rgb: torch.Tensor, f_th: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        b, c, h, w = f_rgb.shape
        stats = torch.cat([
            f_rgb.mean(1, keepdim=True), f_rgb.amax(1, keepdim=True),
            f_th.mean(1, keepdim=True), f_th.amax(1, keepdim=True),
        ], dim=1)                                              # (B, 4, H, W)
        logits = self.spatial_gate(stats).unsqueeze(2)         # (B, 2, 1, H, W)
        if self.channel_gate is not None:
            ch = self.channel_gate(torch.cat([f_rgb, f_th], dim=1)).view(b, 2, c, 1, 1)
            logits = logits + ch                               # (B, 2, C, H, W) by broadcast
        wgt = logits.softmax(dim=1)
        fused = wgt[:, 0] * f_rgb + wgt[:, 1] * f_th
        return self.proj(fused), wgt.mean(dim=(2, 3, 4))       # weights (B, 2), for logging / regularisation


# --------------------------------------------------------------------------
# Heads (placeholders)
# --------------------------------------------------------------------------
class _DummyHead(nn.Module):
    """Placeholder head. TODO: replace with neck (PAN-FPN) + YOLOv8 Detect, taking
    the fused features in level order. With P2 enabled the neck needs a stride-4 branch."""

    def __init__(self, chs: Sequence[int], num_classes: int):
        super().__init__()
        self.preds = nn.ModuleList(nn.Conv2d(c, num_classes + 4, 1) for c in chs)

    def forward(self, feats: Sequence[torch.Tensor]):
        return [m(f) for m, f in zip(self.preds, feats)]


# --------------------------------------------------------------------------
# Detector
# --------------------------------------------------------------------------
class DualStreamDetector(nn.Module):
    def __init__(self, num_classes: int = 80, use_tiny_p2: bool = False,
                 thermal_in_ch: int = 3, modality_dropout_p: float = 0.1,
                 aux_stream_heads: bool = True, aux_illum: bool = False,
                 weights=DEFAULT_WEIGHTS, backbone_verbose: bool = False):
        super().__init__()
        self.levels = (2, 3, 4, 5) if use_tiny_p2 else (3, 4, 5)
        self.thermal_in_ch = thermal_in_ch
        self.modality_dropout_p = modality_dropout_p

        self.backbone = DualStreamBackbone(self.levels, thermal_in_ch=thermal_in_ch,
                                           weights=weights, verbose=backbone_verbose)
        chs = [self.backbone.out_channels[l] for l in self.levels]

        # P2 is the largest map (stride 4), so it uses the light fusion.
        self.fusions = nn.ModuleDict({
            str(l): QAFMFusion(self.backbone.out_channels[l], light=(l == 2)) for l in self.levels
        })
        self.head = _DummyHead(chs, num_classes)

        # Optional: deep supervision per stream, to avoid one modality being ignored.
        self.aux_rgb = _DummyHead(chs, num_classes) if aux_stream_heads else None
        self.aux_th = _DummyHead(chs, num_classes) if aux_stream_heads else None

        # Optional: day/night classifier on RGB P5, gives the gate a quality signal.
        self.illum_head = None
        if aux_illum:
            self.illum_head = nn.Sequential(
                nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(self.backbone.out_channels[5], 2))

    # -- input handling ------------------------------------------------------
    def _split(self, x: torch.Tensor, thermal: Optional[torch.Tensor]):
        if thermal is None:                       # 6-channel input: RGB | thermal
            rgb, th = x[:, :3], x[:, 3:]
        else:
            rgb, th = x, thermal
        if self.thermal_in_ch == 1 and th.shape[1] != 1:
            th = th.mean(dim=1, keepdim=True)
        elif self.thermal_in_ch == 3 and th.shape[1] == 1:
            th = th.expand(-1, 3, -1, -1)
        return rgb, th

    def forward(self, x: torch.Tensor, thermal: Optional[torch.Tensor] = None) -> dict:
        rgb, th = self._split(x, thermal)
        if self.training:
            rgb, th = modality_dropout(rgb, th, self.modality_dropout_p)

        f_rgb, f_th = self.backbone(rgb, th)
        fused, gates = [], {}
        for l in self.levels:
            f, g = self.fusions[str(l)](f_rgb[l], f_th[l])
            fused.append(f)
            gates[l] = g

        out = {"preds": self.head(fused), "gates": gates}
        if self.training:
            if self.aux_rgb is not None:
                out["aux_rgb"] = self.aux_rgb([f_rgb[l] for l in self.levels])
                out["aux_th"] = self.aux_th([f_th[l] for l in self.levels])
            if self.illum_head is not None:
                out["illum"] = self.illum_head(f_rgb[5])
        return out


# --------------------------------------------------------------------------
# TODO list
# --------------------------------------------------------------------------
# 1. Replace _DummyBackbone with real YOLOv8 backbones (keep {level: feat} contract);
#    init both from COCO weights; consider a lower LR for the thermal stream.
# 2. Paired dataloader -> 6-channel tensor (RGB | thermal). Same geometric aug on both
#    (mosaic / flip / scale), independent photometric aug per modality; HSV only on RGB.
#    If thermal is single-channel, set thermal_in_ch=1 and use adapt_first_conv_to_1ch.
# 3. Real neck + Detect head with a stride-4 branch for Tiny-P2 (levels=(2,3,4,5)).
# 4. Adapter to the ultralytics training pipeline (DetectionModel subclass or output
#    wrapper): loss on out["preds"], plus weighted aux losses on aux_rgb / aux_th,
#    optional CE on out["illum"] with a day/night label.
# 5. Check the pairs are aligned; if not, add an alignment module before QAFM.

if __name__ == "__main__":
    # P2-P5 with two independent YOLOv8n-OBB backbones.
    model = DualStreamDetector(num_classes=5, use_tiny_p2=True, aux_illum=True)
    model.train()
    x = torch.randn(2, 6, 640, 640)                           # RGB | thermal
    out = model(x)
    print("use_tiny_p2=True")
    print("  preds:", [tuple(o.shape) for o in out["preds"]])
    print("  gates:", {k: tuple(v.shape) for k, v in out["gates"].items()})
    print("  aux  :", len(out["aux_rgb"]), "levels, illum", tuple(out["illum"].shape))
    model.eval()
    with torch.no_grad():
        out = model(torch.randn(2, 3, 640, 640), torch.randn(2, 3, 640, 640))  # two-arg form
    print("  eval keys:", sorted(out))
