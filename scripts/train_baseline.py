"""
单模态基线训练脚本
用法：
  python scripts/train_baseline.py rgb      # 跑RGB基线
  python scripts/train_baseline.py thermal   # 跑红外基线
"""
import sys
from ultralytics import YOLO

def main():
    # 选择模态
    if len(sys.argv) > 1 and sys.argv[1] == "thermal":
        config = "configs/dronevehicle_thermal.yaml"
        exp_name = "thermal_yolov8n"
    else:
        config = "configs/dronevehicle_rgb.yaml"
        exp_name = "rgb_yolov8n"

    print(f"开始训练：{exp_name}")
    print(f"配置文件：{config}")

    # 加载预训练模型
    model = YOLO("yolov8n.pt")

    # 开始训练
    results = model.train(
        data=config,
        epochs=100,
        imgsz=640,
        batch=8,
        device=0,
        project="runs/baseline",
        name=exp_name,
        patience=20,
        save=True,
    )

    # 验证集评估
    metrics = model.val()
    print(f"\n===== {exp_name} 结果 =====")
    print(f"mAP50: {metrics.box.map50:.4f}")
    print(f"mAP50-95: {metrics.box.map:.4f}")

if __name__ == "__main__":
    main()
