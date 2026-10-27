# 天巡双瞳 · tianxun-dual-patrol

面向全天候交通场景的无人机视角多模态小目标检测系统

## 项目简介

基于 RGB + 热红外（Thermal）双模态融合的无人机交通目标检测系统，针对高空小目标、夜间低可见度、密集遮挡三大痛点，实现全天候、高召回率的实时检测。

## 核心模块

- **QAFM**：质量感知跨模态融合，根据模态质量动态分配权重
- **Tiny-P2**：高分辨率小目标检测头，优化 <32×32 像素目标
- **双流编码**：RGB / Thermal 双分支特征提取与融合

## 团队成员

| 姓名 | 职责 |
|------|------|
| 张涵杰 | 组长 · 系统架构 + QAFM融合 |
| 林宸宇 | 双流编码器 + Tiny-P2检测头 |
| 陈宇 | 数据工程 + 训练实验 + 消融 |
| 王麒瑞 | 推理部署 + 可视化演示 |

## 快速开始

### 1. 环境准备
```bash
# 克隆仓库
git clone https://github.com/lab245/tianxun-dual-patrol.git
cd tianxun-dual-patrol

# 安装依赖（建议GPU版PyTorch）
pip install -r requirements.txt

# 安装YOLOv8官方代码（editable模式）
git clone https://github.com/ultralytics/ultralytics.git
pip install -e ultralytics/
```

### 2. 数据准备
```bash
# 下载DroneVehicle数据集，解压到 data/DroneVehicle/
# 目录结构：
# data/DroneVehicle/
#   train/RGB/*.jpg
#   train/IR/*.jpg
#   train/XML/*.xml
#   val/RGB/*.jpg
#   val/IR/*.jpg
#   val/XML/*.xml

# 标签格式转换（VOC XML -> YOLO TXT）
python scripts/convert_dronevehicle.py
```

### 3. 单模态基线训练
```bash
# RGB单模态基线（先跑通这个）
python scripts/train_baseline.py rgb
python scripts/train_baseline.py thermal

# 或者直接用yolo命令
yolo detect train data=configs/dronevehicle_rgb.yaml model=yolov8n.pt epochs=100 imgsz=640 device=0
```

> 已完成的正式 YOLOv8n-OBB 单模态基线（RGB mAP50 75.37% / Thermal 80.17%）见 [`experiments/baseline_obb/`](experiments/baseline_obb/README.md)，作为双流实验对照起跑线。

### 4. 双流模型开发中
- 模型骨架：`src/models/dual_stream_yolo.py`
- 真实 backbone：`src/models/yolov8_backbone.py`（YOLOv8n-OBB 前 10 层，P2–P5）
- 数据加载器：`src/data/dataset_dual.py`
- 已完成：真实 backbone 替换（RGB / 红外两路独立）、P2–P5 形状自测、整网随机数据前向
- 待完成：真实 neck + Detect 对接、训练 pipeline

```bash
# 单路 backbone 形状自测（P2–P5）
python scripts/test_yolov8_backbone.py

# 整网随机数据前向
python scripts/test_dual_stream_forward.py
```

> 本机无 NVIDIA GPU，当前验证在 CPU（torch 2.14.1+cpu）上完成；代码不绑定设备，
> 迁到 GPU 机器后直接复用同样的脚本。环境、形状表与汇报材料见
> [`experiments/w2_yolov8_backbone/`](experiments/w2_yolov8_backbone/README.md)。

## 项目阶段

- [x] 仓库初始化
- [x] W1：数据校验 + 单模态基线（OBB 两路正式结果已出，见 experiments/baseline_obb/）
- [ ] W2：双流框架 + 简单融合
- [ ] W3-W4：QAFM + Tiny-P2 开发
- [ ] W5-W6：消融实验
- [ ] W7：推理部署 + 演示
- [ ] W8：答辩提交

## 竞赛信息

- 赛事：服务外包创新创业大赛
- 赛题：A18 计算类
- 
