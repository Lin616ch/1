"""Generate a Chinese report from observed artifacts and package reproducible stage outputs."""
import argparse,csv,hashlib,json,zipfile
from pathlib import Path
from collect_results import collect
ROOT=Path(__file__).resolve().parents[1]
def load(rel):return json.loads((ROOT/rel).read_text(encoding='utf-8'))
def pct(x):return f'{x*100:.2f}%'
def report():
    collect()
    stats=load('reports/processing_summary.json');env=load('reports/environment.json')
    diag=load('reports/paired_scene_diagnostics.json')
    lines=['# DroneVehicle 阶段结果报告','',
      '**完成范围：官方训练集的数据检查和 OBB 转换、独立 CUDA 环境、RGB/thermal 两次 GPU 小规模试跑及结果整理。正式 100 轮基线、官方验证和测试尚未执行，原因是官方 val/test 未下载。**','',
      '## 数据与预处理','',
      '本地源数据位于 `D:\\train\\train`，每模态 17,990 张图片和 17,990 份 XML。35,980 张源图片均已实际解码；未发现坏图、缺图或缺标签。所有源图片及 XML 均保留。',
      '两模态按各自 XML 独立转换，保留 840×712 画布及四周白边，不减 100、不裁图。单通道 thermal 由加载器复制为三通道。','',
      '|集合|模态|源图|导出图|隔离样本|目标数|','|---|---|---:|---:|---:|---:|']
    for s in stats['statistics']:
        lines.append('|'+ '|'.join(str(s[k]) for k in ['split','modality','source_images','exported_images','quarantined_pairs','objects'])+'|')
    lines+=['','val/test 空值表示缺失，不能解释为官方集合为空。每模态保留 512 / 33 份原始空标签（RGB / thermal）。','',
      '|异常事件|次数|','|---|---:|']
    for k,v in stats['events'].items():lines.append(f'|{k}|{v}|')
    lines+=['','异常事件次数不是隔离样本数：一个文件可能同时有多个问题。最终隔离的是 33 对样本。point 没有尺寸、退化框、未知类别等按整对隔离；一处精确重复标签去重并记录。类别映射与逐对象日志见 configs/class_mapping.json、reports/events.csv。','',
      '## 环境与匹配设置','',
      f"GPU：{env['gpu']}，显存约 8 GB；驱动 573.24。Python 3.11.5；torch {env['torch']}、torchvision {env['torchvision']}、CUDA runtime {env['torch_cuda']}、Ultralytics {env['ultralytics']}。GPU 前向/反向测试通过，pip check 通过。完整版本见 requirements-lock.txt。",'',
      '两条自建 YOLOv8n-OBB 基线均从同一份 DOTA 预训练文件独立初始化，SHA-256 为 `fa6e4cd2691f132875c143135affaa66b5d89394ebb1d07d19770a9b6382c1b8`。并非 UA-CMDet 原论文复现。',
      '试跑共同设置：seed=42、2 轮、imgsz=640、batch=8、SGD、FP32（amp=False）、workers=0；其余参数见各次 requested.json 和 args.yaml。每模态使用相同编号的 64 张训练图与 16 张流程检查图，全部来自官方 train。二者编号无重叠，但不保证场景独立，故不能据此评价泛化。','',
      '## 实测流程检查指标','',
      '|模态|Precision|Recall|mAP@50|mAP@50:95|','|---|---:|---:|---:|---:|']
    for mod in ['rgb','thermal']:
        r=load(f'reports/smoke_{mod}_debug_holdout_from_official_train_metrics.json')['summary']
        lines.append('|'+mod+'|'+'|'.join(pct(r[k]) for k in ['precision','recall','mAP50','mAP50_95'])+'|')
    lines+=['','上述为训练完成后单独加载 best.pt 的独立评估结果。训练期 results.csv 中的验证数值可能因推理精度等实现细节与独立评估略有差别，汇总表统一采用独立评估。',
      '主评估使用锁定版本 Ultralytics OBB 的 ProbIoU 旋转矩形匹配，AP 阈值 0.50:0.05:0.95；conf=0.001、NMS iou=0.7、max_det=300。P/R 为实现选取的 F1 工作点，不是 conf=0.25 的 P/R。各类别 AP 已保存到 per_class_AP.csv。该口径不等同于原论文/DOTA 官方多边形 IoU 评测。','',
      '两轮试跑没有收敛；这组数字只说明数据读取、损失、GPU 训练、选权重、评估和保存链路已实际运行。不能当作完整基线，也不能据此声称 thermal 优于 RGB。正式验证与测试指标在比较 CSV 中保持空白并标记 not_run。','',
      '## 同场景检测与问题分析','',
      '固定选取检查清单前四个共同编号：05633、17536、08050、05380。两模态分别使用自身标注，在 conf=0.25 下均没有输出检测，因此未观测到误检；这不说明模型误检率低。',
      '|模态|四个场景 GT 合计|TP|FP|FN|','|---|---:|---:|---:|---:|']
    for mod in ['rgb','thermal']:
        ds=[x for x in diag if x['modality']==mod]
        lines.append('|'+mod+'|'+'|'.join(str(sum(x[k] for x in ds)) for k in ['ground_truth','TP','FP','FN'])+'|')
    lines+=['',
      '诊断图以类别一致、精确多边形 IoU≥0.50 匹配，红色标出漏检；与主表 ProbIoU AP 口径不同。较低 conf 的 AP 能非零，而 conf=0.25 的示例无检测，两者不矛盾。当前首要问题是数据少、轮数少、检测头尚未形成足够置信度，后续应先完成正式训练，再讨论稳定的漏检/误检类型。',
      '训练集 car 占比约 86%，类别明显不均衡。少数类在 16 张图中的目标极少，单个样本即可显著影响 AP。保留白边也会减少固定输入中有效图像内容的分辨率；这些因素需在完整实验后分析。原始 bndbox 仅能转成水平矩形；四边形进入 Ultralytics 后拟合旋转矩形，均应随指标披露。','',
      '## 后续与交付','',
      '补齐官方 val/test 后按官方身份转换并查重；两条完整实验使用相同模型、初始权重、100 轮、640 输入、batch=8、seed=42。当前两次试跑峰值张量显存约 1.73 GiB，batch=8 已实际运行稳定；该数值不等于驱动全部占用或完整数据训练的最大显存。验证集选 best，模型和设置确定后再测 test。',
      '建议下载目录：D:\\DroneVehicle\\val 和 D:\\DroneVehicle\\test。官方链接、提取码、复现命令及评估口径见 README_运行说明.md。结果包不含数据与模型权重；派生数据完整保留在 data/，权重另包。当前没有执行外部上传。','']
    (ROOT/'结果报告.md').write_text('\n'.join(lines),encoding='utf-8')
    for mod in ['rgb','thermal']:
        cfg=load(f'configs/smoke_{mod}_requested.json')
        cfg['training'].update(epochs=100,data=str(ROOT/'configs'/f'{mod}.yaml'),name=f'full_{mod}')
        cfg['scope']='planned official_train/official_val experiment; NOT EXECUTED';cfg['status']='waiting_for_official_val'
        (ROOT/'configs'/f'full_{mod}_planned.json').write_text(json.dumps(cfg,ensure_ascii=False,indent=2),encoding='utf-8')

def package():
    out=ROOT.parent
    assert (ROOT/'DroneVehicle_阶段汇报.pptx').is_file(), 'Finalize the presentation before packaging'
    paths=[]
    for p in ROOT.rglob('*'):
        if not p.is_file():continue
        rel=p.relative_to(ROOT)
        if rel.as_posix()=='reports/package_manifest.json':continue
        if rel.parts[0] in ['data','weights'] or '__pycache__' in rel.parts or p.suffix in ['.ttf','.cache']:continue
        if 'ultralytics_settings' in rel.parts or 'matplotlib' in rel.parts:continue
        if 'weights' in rel.parts:continue
        paths.append(p)
    records=[dict(path=p.relative_to(ROOT).as_posix(),bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in sorted(paths)]
    manifest=ROOT/'reports/package_manifest.json';manifest.write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf-8');paths.append(manifest)
    archive=out/'DroneVehicle_阶段结果包.zip'
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in sorted(paths):z.write(p,'dronevehicle_baselines/'+p.relative_to(ROOT).as_posix())
    weights=out/'DroneVehicle_试跑权重.zip'
    with zipfile.ZipFile(weights,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=3) as z:
        for p in sorted((ROOT/'weights').rglob('*')):
            if p.is_file():z.write(p,p.relative_to(ROOT).as_posix())
    for p in [archive,weights]:
        with zipfile.ZipFile(p) as z:assert z.testzip() is None
        print(p,p.stat().st_size,flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--package',action='store_true');args=p.parse_args();report()
    if args.package:package()
