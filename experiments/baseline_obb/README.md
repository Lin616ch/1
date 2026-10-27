# 单模态基线（YOLOv8n-OBB）· 正式结果

本目录归档组员完成的两条 RGB / Thermal 单模态车辆检测正式基线，作为后续双流融合实验的对照起跑线。
> 这是自建基线，不是原论文 UA-CMDet 复现；任务形态为 **OBB 旋转框**，评估使用 Ultralytics ProbIoU，与原论文/DOTA 官方多边形 IoU 口径不同。

## 正式测试集结果（official test）

| 模态 | Precision | Recall | mAP@50 | mAP@50:95 |
|---|---:|---:|---:|---:|
| RGB | 73.78% | 72.27% | **75.37%** | **58.48%** |
| Thermal | 77.53% | 76.19% | **80.17%** | **64.71%** |

验证集（official val）：RGB mAP@50 77.20% / mAP@50:95 60.04%；Thermal 83.02% / 67.28%。

### 各类别 AP50（test）

| 类别 | RGB AP50 | Thermal AP50 | RGB AP50:95 | Thermal AP50:95 |
|---|---:|---:|---:|---:|
| car | 96.64% | 98.32% | 77.44% | 81.92% |
| truck | 75.20% | 79.35% | 56.68% | 61.00% |
| bus | 94.70% | 94.92% | 74.23% | 78.91% |
| van | 54.73% | 59.90% | 42.16% | 48.48% |
| freight_car | 55.56% | 68.38% | 41.88% | 53.26% |

## 实验设置

- 模型：YOLOv8n-OBB，两路从同一份 DOTA 预训练 `yolov8n-obb.pt` 独立初始化，互不继承。
- 数据：官方 train/val/test 划分，统一质量过滤后 train 17957 对、val 1467 对、test 8955 对。
- 训练：imgsz=640、batch=16、seed=42、SGD、FP32、workers=4；HSV/mosaic/mixup/copy-paste 关闭。
- 选模：各自前 60 轮中按官方 val 选 best，冻结后再评 test，未用 test 调参。RGB 实跑 80 轮但采用前 60 轮最佳；Thermal 60 轮停止。
- 环境：RTX 5060 Laptop 8GB，torch 2.7.1+cu128，Ultralytics 8.3.200（见 reports/requirements-lock.txt）。

## 目录说明

```
code/      数据审计、OBB标签导出、训练/选模/测试、结果整理脚本（可复现）
configs/   类别映射、训练预算、数据YAML示例、固定抽样ID
reports/   正式指标JSON、对比CSV、各类AP、环境与选模冻结记录
figures/   训练曲线、PR曲线、归一化混淆矩阵（正式两路）
docs/      正式结果报告.md、DroneVehicle_正式汇报.pptx
```

## 模型权重（不入库）

`.pt` 已被根目录 .gitignore 排除，正式权重保存在本地 `weights/baseline_obb/`：
- `rgb_best.pt`、`thermal_best.pt`：两路正式 best 权重，用于复核指标。
- `yolov8n-obb-initial.pt`：共同 DOTA 预训练初始权重（SHA-256 见 provenance.json）。

> 与早期普通（水平框）检测 `configs/dronevehicle_rgb.yaml` 的类别顺序不同：本基线类别为 0 car / 1 truck / 2 bus / 3 van / 4 freight_car，复用代码时以 configs/class_mapping.json 为准。
