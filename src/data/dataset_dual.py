"""
双流成对数据加载器
同时读取RGB + Thermal成对图像，同步做数据增强
天巡双瞳项目
"""
import os
import random
from pathlib import Path
from typing import Tuple, Dict, List

import cv2
import torch
import numpy as np
from torch.utils.data import Dataset


class DualStreamDataset(Dataset):
    """
    双流数据集：成对读取RGB + Thermal图像
    所有数据增强对两张图同步执行，保证空间对齐
    """
    def __init__(
        self,
        data_root: str,
        split: str = "train",
        img_size: int = 640,
        augment: bool = True,
    ):
        """
        Args:
            data_root: 数据集根目录（data/DroneVehicle/）
            split: 'train' 或 'val'
            img_size: 输入图片尺寸
            augment: 是否做数据增强
        """
        super().__init__()
        self.data_root = Path(data_root)
        self.split = split
        self.img_size = img_size
        self.augment = augment and (split == "train")

        # 路径配置
        self.rgb_dir = self.data_root / split / "RGB"
        self.thermal_dir = self.data_root / split / "IR"
        self.label_dir = self.data_root / split / "labels"

        # 获取所有图片文件名
        self.img_names = sorted([f.stem for f in self.rgb_dir.glob("*.jpg")])
        print(f"[{split}] 加载 {len(self.img_names)} 对双流图像")

    def __len__(self) -> int:
        return len(self.img_names)

    def _load_image(self, path: Path) -> np.ndarray:
        """读取图片，统一转3通道"""
        img = cv2.imread(str(path))
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        return img

    def _load_labels(self, name: str) -> np.ndarray:
        """读取YOLO格式标签，返回 shape (N, 5) [cls, x, y, w, h]"""
        label_path = self.label_dir / f"{name}.txt"
        if not label_path.exists():
            return np.zeros((0, 5), dtype=np.float32)

        labels = []
        with open(label_path, "r") as f:
            for line in f.readlines():
                parts = line.strip().split()
                if len(parts) == 5:
                    labels.append([float(x) for x in parts])
        return np.array(labels, dtype=np.float32) if labels else np.zeros((0, 5), dtype=np.float32)

    def _random_flip(self, rgb: np.ndarray, thermal: np.ndarray, labels: np.ndarray):
        """随机水平翻转（两张图同步）"""
        if random.random() < 0.5:
            rgb = np.fliplr(rgb).copy()
            thermal = np.fliplr(thermal).copy()
            if len(labels) > 0:
                labels[:, 1] = 1.0 - labels[:, 1]  # x_center翻转
        return rgb, thermal, labels

    def _resize(self, rgb: np.ndarray, thermal: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """缩放到统一尺寸"""
        rgb = cv2.resize(rgb, (self.img_size, self.img_size))
        thermal = cv2.resize(thermal, (self.img_size, self.img_size))
        return rgb, thermal

    def __getitem__(self, idx: int) -> Dict[str, torch.Tensor]:
        name = self.img_names[idx]

        # 1. 读成对图像
        rgb = self._load_image(self.rgb_dir / f"{name}.jpg")
        thermal = self._load_image(self.thermal_dir / f"{name}.jpg")
        h0, w0 = rgb.shape[:2]

        # 2. 读标签
        labels = self._load_labels(name)

        # 3. 数据增强（同步执行）
        if self.augment:
            rgb, thermal, labels = self._random_flip(rgb, thermal, labels)

        # 4. 缩放
        rgb, thermal = self._resize(rgb, thermal)

        # 5. 归一化到 [0, 1]，转CHW格式
        rgb = torch.from_numpy(rgb).permute(2, 0, 1).float() / 255.0
        thermal = torch.from_numpy(thermal).permute(2, 0, 1).float() / 255.0

        # 6. 标签转tensor
        if len(labels) > 0:
            # YOLO格式: [cls, x_center, y_center, w, h] -> [batch_idx, cls, x, y, w, h]
            targets = torch.zeros((len(labels), 6))
            targets[:, 1:] = torch.from_numpy(labels)
        else:
            targets = torch.zeros((0, 6))

        return {
            "rgb": rgb,           # (3, H, W)
            "thermal": thermal,    # (3, H, W)
            "labels": targets,    # (N, 6) [img_idx, cls, x, y, w, h]
            "img_name": name,
        }


def collate_fn(batch: List[Dict]) -> Dict:
    """自定义batch拼接函数"""
    rgb = torch.stack([item["rgb"] for item in batch])
    thermal = torch.stack([item["thermal"] for item in batch])

    # 标签要加上batch索引
    all_targets = []
    for i, item in enumerate(batch):
        t = item["labels"].clone()
        t[:, 0] = i  # 第0列是batch索引
        all_targets.append(t)
    targets = torch.cat(all_targets, dim=0) if all_targets else torch.zeros((0, 6))

    return {
        "rgb": rgb,
        "thermal": thermal,
        "labels": targets,
        "img_names": [item["img_name"] for item in batch],
    }


# ============ 测试 ============
if __name__ == "__main__":
    print("双流数据加载器测试")
    print("等数据下完后，把路径改成实际位置即可使用")
    print()
    print("使用示例：")
    print("  from src.data.dataset_dual import DualStreamDataset, collate_fn")
    print("  from torch.utils.data import DataLoader")
    print()
    print("  train_set = DualStreamDataset('data/DroneVehicle', split='train')")
    print("  train_loader = DataLoader(train_set, batch_size=8, shuffle=True, collate_fn=collate_fn)")
    print()
    print("  for batch in train_loader:")
    print("      rgb = batch['rgb']        # (B, 3, 640, 640)")
    print("      thermal = batch['thermal']  # (B, 3, 640, 640)")
    print("      labels = batch['labels']     # (N, 6)")
    print("      break")
