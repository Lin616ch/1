"""Create the official-split report only after both budget-complete models and tests exist."""
import argparse,csv,hashlib,json,zipfile
from pathlib import Path
from collect_results import collect
from training_budget import full_budget
ROOT=Path(__file__).resolve().parents[1]
NAMES=['car','truck','bus','van','freight_car']
def load(p):return json.loads((ROOT/p).read_text(encoding='utf-8'))
def percent(n):return f'{100*n:.2f}%'
def report():
    collect();statistics=load('reports/processing_summary.json')['statistics']
    frozen=load('reports/model_selection_frozen.json')
    metrics={(mod,split):load(f'reports/full_{mod}_official_{split}_metrics.json') for mod in ['rgb','thermal'] for split in ['val','test']}
    executions={mod:load(f'reports/full_{mod}_execution.json') for mod in ['rgb','thermal']}
    assert all(x.get('comparison_epochs',x['epochs_completed'])==full_budget()[0] and x['epochs_completed']>=full_budget()[0] and x['finite_training_losses'] for x in executions.values())
    env=load('reports/environment.json');diagnostics=load('reports/full_paired_scene_diagnostics.json')
    lines=['# DroneVehicle 两条单模态车辆检测基线：正式结果','',
      'YOLOv8n-OBB 自建基线；使用官方 train / val / test 划分，经统一质量过滤后训练和评估。此工作不是原论文 UA-CMDet 复现。下面所有指标均来自实际完成的运行。','',
      '## 数据处理与划分','',
      '源目录：D:\\train\\train、D:\\val\\val、D:\\test\\test。保持官方集合身份，不重新随机分配 train/val/test；原始文件未修改。','',
      '|集合|模态|原始图片|保留图片|隔离样本|标注目标|','|---|---|---:|---:|---:|---:|']
    for s in statistics:lines.append('|'+ '|'.join(str(s[k]) for k in ['split','modality','source_images','exported_images','quarantined_pairs','objects'])+'|')
    lines+=['','五类固定为 0 car、1 truck、2 bus、3 van、4 freight_car。拼写别名显式记录；点标注、退化框、未知类别及不合法四边形导致样本成对隔离。精确重复标签去重并记录。各集合各类别目标数见 dataset_statistics.csv，逐项处理原因见 events.csv，源图片/XML 哈希见 manifest.csv。',
      '保留 840×712 原画布及四周白边，坐标不减 100、不裁图，不机械截断旋转框。polygon 校验凸性后规范循环顺序，bndbox 转四角矩形。YOLO 标签为类别编号加 8 个归一化顶点坐标。RGB 与 thermal 分别使用各自 XML；thermal 单通道由加载器复制为三通道。',
      '全量图像解码、标签规范、同名配对及精确跨集合图片哈希检查结果见 official_export_validation.json。该查重不等于排除了所有相近场景。固定 seed=42 的标注检查图及测试场景编号在训练前确定并保存。','',
      '## 模型与实验设置','',
      f"本机 GPU 为 {env['gpu']}，约 8 GB 显存；torch {env['torch']}、torchvision {env['torchvision']}、CUDA runtime {env['torch_cuda']}、Ultralytics {env['ultralytics']}。完整依赖版本见 requirements-lock.txt。",'',
      '两条基线从同一份官方 DOTA 预训练 yolov8n-obb.pt 独立启动，初始 SHA-256：`'+frozen['initial_sha256']+'`。模型、对比轮数窗口、输入尺寸、batch、优化器、随机种子和增强参数一致；只有数据路径及运行名称不同。没有把 RGB 训练后的权重作为 thermal 初始化。',
      '正式对比统一采用各自前 60 轮中由官方 val 选出的最佳模型，imgsz=640、batch=16、seed=42、SGD、FP32、workers=4；HSV、mosaic、mixup、copy-paste 关闭。两路使用相同的原 100 轮学习率计划，不重新缩放。RGB 实际已训练 80 轮，按用户加快交付的选择，使用此前完整保留的前 60 轮最佳检查点，原 80 轮权重、验证结果和全部历史另存并保留，不将第 61–80 轮用于正式模型选择。thermal 独立从共同预训练权重训练，在完成 60 轮后停止。两路训练损失有限；选择凭据见 rgb_prefix60_selection.json 和 comparison_budget60_change.json。',
      '每条模型使用自身模态的官方 val 选择 best.pt。两条训练和验证完成后冻结 best 权重校验值与配置，之后才评估官方 test，冻结记录见 model_selection_frozen.json；未根据 test 调参。','',
      '|模态|实际训练历史轮数|对比选择窗口|最后一次训练进程用时（小时）|峰值张量显存（GiB）|','|---|---:|---:|---:|---:|']
    for mod,e in executions.items():lines.append(f"|{mod}|{e['epochs_completed']}|{e.get('comparison_epochs',e['epochs_completed'])}|{e['elapsed_seconds']/3600:.3f}|{e['peak_cuda_allocated_bytes']/1024**3:.3f}|")
    lines+=['','上表用时仅统计最后一次训练进程，RGB 有中断和续训，不代表总训练耗时，不能据此比较两种模态的训练速度。中断和驱动变更记录见 runtime_notes.json。','','## 独立评估结果','',
      '|集合|模态|Precision|Recall|mAP@50|mAP@50:95|','|---|---|---:|---:|---:|---:|']
    for split in ['val','test']:
        for mod in ['rgb','thermal']:
            m=metrics[(mod,split)]['summary'];lines.append('|'+split+'|'+mod+'|'+'|'.join(percent(m[k]) for k in ['precision','recall','mAP50','mAP50_95'])+'|')
    lines+=['','评估采用锁定版本 Ultralytics OBB：内部对四边形拟合旋转矩形，匹配使用 ProbIoU 相似度，AP 阈值 0.50:0.05:0.95。验证/测试 conf=0.001、NMS iou=0.7、max_det=300；P/R 为实现选择的 F1 工作点。此口径不等同于原论文/DOTA 官方多边形 IoU 评测，不能直接宣称复现论文指标。正式结果也不能与先前两轮试跑混为一谈。','',
      '|测试类别|RGB AP50|thermal AP50|RGB AP50:95|thermal AP50:95|','|---|---:|---:|---:|---:|']
    byclass={mod:{r['name']:r for r in metrics[(mod,'test')]['per_class']} for mod in ['rgb','thermal']}
    for n in NAMES:
        vals=[]
        for key,mod in [('AP50','rgb'),('AP50','thermal'),('AP50_95','rgb'),('AP50_95','thermal')]:vals.append(percent(byclass[mod][n][key]) if n in byclass[mod] else '无 GT，不定义')
        lines.append('|'+n+'|'+'|'.join(vals)+'|')
    lines+=['','全部汇总与各类 AP 已另存 experiment_comparison.csv 和 per_class_AP.csv。训练曲线、PR 曲线、混淆矩阵与配置见 runs/ 下相应训练和评估目录。','',
      '## 配对场景检测与误差分析','',
      '测试场景在训练前以 seed=42 固定选取，使用相同编号对比两种模态，且各自对照自身标签。诊断固定 conf=0.25、相同类别下精确多边形 IoU≥0.50 贪心匹配，红色 FN、橙色 FP、绿色 TP。该诊断与主表 ProbIoU AP 的口径不同。','',
      '|模态|固定场景 GT|输出预测|TP|FP|FN|','|---|---:|---:|---:|---:|---:|']
    for mod in ['rgb','thermal']:
        d=[r for r in diagnostics if r['modality']==mod]
        lines.append('|'+mod+'|'+'|'.join(str(sum(r[k] for r in d)) for k in ['ground_truth','predictions','TP','FP','FN'])+'|')
    delta=(metrics[('thermal','test')]['summary']['mAP50_95']-metrics[('rgb','test')]['summary']['mAP50_95'])*100
    lines+=['',f'在本次筛选后的官方 test 及上述评估实现下，thermal 相对 RGB 的 mAP@50:95 差值为 {delta:+.2f} 个百分点。这只是本次单种子实验的差值，不是显著性检验或普遍优势证明。',
      'RGB 与 thermal 原始目标标注数量不同，因此两条单模态基线的差异不能全部归因于输入模态。car 占比高，少数类样本、密集小目标及边界目标应结合每类 AP 和可视化分析。保留白边会减少固定 640 输入下有效内容像素数；这些是可能影响结果的因素，未做消融时不能认定因果。',
      '固定四场景的误检/漏检计数不能替代全测试集的 P/R；可视化用于解释具体模型行为。具体场景数字见 full_paired_scene_diagnostics.csv。','',
      '## 可复现交付','',
      '代码、环境说明、固定数据/类别映射、指标、日志、曲线、标注和检测可视化、9 页中文 PPT 已归入正式结果包；模型初始权重和两条正式 best/last 权重单独保存。派生图片和标签位于 data/，原始数据仍保留在 D 盘。未执行外部上传。',
      '交付代码与配置支持复跑实验流程，交付权重用于复核本次指标。本次经历多次中断恢复，检查点未保存完整随机数及数据加载器迭代状态；从头复跑或改变恢复位置时，不承诺逐位一致的权重或完全相同的数值。RGB 的 80 轮原始历史、前 60 轮选模证据和 thermal 的 60 轮历史均保留。','']
    (ROOT/'正式结果报告.md').write_text('\n'.join(lines),encoding='utf-8')
    readme=ROOT/'README_运行说明.md'
    text=readme.read_text(encoding='utf-8')
    text=text.replace('本机正在执行两路前 60 轮的模型选择与对比、冻结模型、独立测试及正式结果整理。','两路前 60 轮的模型对比、模型冻结和官方独立测试均已完成。正式实测结果见 正式结果报告.md；流水线最终交付与视觉复核状态见状态 JSON。')
    readme.write_text(text,encoding='utf-8')
    (ROOT/'reports/full_result_summary.json').write_text(json.dumps({'status':'training_and_test_completed','executions':executions,'metrics':{f'{mod}_{split}':m['summary'] for (mod,split),m in metrics.items()},'thermal_minus_rgb_test_map5095_percentage_points':delta},ensure_ascii=False,indent=2),encoding='utf-8')
    print('Official report created',flush=True)
def package():
    assert (ROOT/'DroneVehicle_正式汇报.pptx').is_file()
    out=ROOT.parent;paths=[]
    for p in ROOT.rglob('*'):
        if not p.is_file():continue
        rel=p.relative_to(ROOT)
        if rel.parts[0] in ['data','weights'] or 'weights' in rel.parts or '__pycache__' in rel.parts:continue
        if p.suffix in ['.ttf','.cache'] or 'ultralytics_settings' in rel.parts or 'matplotlib' in rel.parts:continue
        if rel.as_posix() in ['reports/full_package_manifest.json','reports/package_manifest.json']:continue
        paths.append(p)
    records=[{'path':p.relative_to(ROOT).as_posix(),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(paths)]
    manifest=ROOT/'reports/full_package_manifest.json';manifest.write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8');paths.append(manifest)
    for name,files in [('DroneVehicle_正式结果包.zip',paths),('DroneVehicle_正式模型权重.zip',[p for p in (ROOT/'weights').rglob('*') if p.is_file() and not any(part.startswith('smoke_') for part in p.relative_to(ROOT).parts)])]:
        dest=out/name
        with zipfile.ZipFile(dest,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=5) as z:
            for p in sorted(files):z.write(p,'dronevehicle_baselines/'+p.relative_to(ROOT).as_posix())
        with zipfile.ZipFile(dest) as z:assert z.testzip() is None
        print(dest,dest.stat().st_size,flush=True)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--package',action='store_true');args=parser.parse_args();report()
    if args.package:package()
