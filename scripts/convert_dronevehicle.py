"""
DroneVehicle VOC XML -> YOLO TXT 标签转换脚本
用法：python scripts/convert_dronevehicle.py
"""
import os
import xml.etree.ElementTree as ET
from pathlib import Path
from tqdm import tqdm

# ============ 配置 ============
DATA_ROOT = Path("data/DroneVehicle")  # 数据集根目录
SPLITS = ["train", "val"]  # 处理的数据集划分

# 类别映射（DroneVehicle类别 -> YOLO class_id）
# DroneVehicle原始类别：car, bus, truck, van, freight car
CLASS_MAP = {
    "car": 0,
    "bus": 1,
    "truck": 2,
    "van": 3,
    "freight car": 4,
    "freight_car": 4,
}
# ==============================


def convert_xml_to_yolo(xml_path: Path, output_path: Path):
    """将单个VOC XML文件转换为YOLO txt格式"""
    tree = ET.parse(xml_path)
    root = tree.getroot()

    # 获取图片尺寸
    size = root.find("size")
    img_w = int(size.find("width").text)
    img_h = int(size.find("height").text)

    lines = []
    for obj in root.iter("object"):
        cls_name = obj.find("name").text.strip().lower()
        if cls_name not in CLASS_MAP:
            print(f"  警告：未知类别 '{cls_name}'，跳过 ({xml_path.name})")
            continue

        cls_id = CLASS_MAP[cls_name]

        # 获取边界框
        bbox = obj.find("bndbox")
        xmin = float(bbox.find("xmin").text)
        ymin = float(bbox.find("ymin").text)
        xmax = float(bbox.find("xmax").text)
        ymax = float(bbox.find("ymax").text)

        # 转为YOLO格式：中心点坐标 + 宽高，归一化
        x_center = (xmin + xmax) / 2.0 / img_w
        y_center = (ymin + ymax) / 2.0 / img_h
        w = (xmax - xmin) / img_w
        h = (ymax - ymin) / img_h

        lines.append(f"{cls_id} {x_center:.6f} {y_center:.6f} {w:.6f} {h:.6f}")

    # 写入txt文件
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.write("\n".join(lines))


def main():
    print(f"DroneVehicle 标签转换工具")
    print(f"数据根目录: {DATA_ROOT.resolve()}")
    print(f"类别映射: {CLASS_MAP}")
    print()

    for split in SPLITS:
        xml_dir = DATA_ROOT / split / "XML"
        if not xml_dir.exists():
            print(f"[{split}] XML目录不存在: {xml_dir}，跳过")
            continue

        # 输出目录：RGB和IR共用同一套labels
        output_dir = DATA_ROOT / split / "labels"
        xml_files = list(xml_dir.glob("*.xml"))

        print(f"[{split}] 找到 {len(xml_files)} 个XML标签文件")
        print(f"[{split}] 输出到: {output_dir}")

        for xml_file in tqdm(xml_files, desc=f"转换{split}"):
            txt_file = output_dir / (xml_file.stem + ".txt")
            convert_xml_to_yolo(xml_file, txt_file)

        print(f"[{split}] 完成！")
        print()

    print("全部转换完成！")
    print(f"接下来可以训练了：")
    print(f"  yolo detect train data=configs/dronevehicle_rgb.yaml model=yolov8n.pt epochs=100 imgsz=640 device=0")


if __name__ == "__main__":
    main()
