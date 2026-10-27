"""Matched YOLOv8n-OBB experiments. Official runs require official validation data."""
import argparse, csv, hashlib, json, math, os, platform, shutil, subprocess, sys, time
from pathlib import Path
from training_budget import full_budget, attach_budget

ROOT=Path(__file__).resolve().parents[1]
os.environ['YOLO_CONFIG_DIR']=str(ROOT/'configs'/'ultralytics_settings')
os.environ['MPLCONFIGDIR']=str(ROOT/'configs'/'matplotlib')
os.environ['YOLO_AUTOINSTALL']='false'
os.environ['CUBLAS_WORKSPACE_CONFIG']=':4096:8'
os.environ['WANDB_DISABLED']='true'

def dump(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')

def probe():
    import torch, torchvision, ultralytics, cv2, numpy, PIL
    info=dict(python=sys.version,executable=sys.executable,platform=platform.platform(),torch=torch.__version__,torchvision=torchvision.__version__,torch_cuda=torch.version.cuda,ultralytics=ultralytics.__version__,opencv=cv2.__version__,numpy=numpy.__version__,pillow=PIL.__version__,cuda_available=torch.cuda.is_available())
    info['nvidia_smi']=subprocess.check_output(['nvidia-smi','--query-gpu=name,memory.total,memory.free,driver_version','--format=csv'],text=True)
    if info['cuda_available']:
        info['gpu']=torch.cuda.get_device_name(0); info['compute_capability']=torch.cuda.get_device_capability(0); info['compiled_arches']=torch.cuda.get_arch_list()
        x=torch.randn(128,128,device='cuda',requires_grad=True); (x@x).square().mean().backward(); torch.cuda.synchronize()
        info['cuda_forward_backward_passed']=bool(torch.isfinite(x.grad).all())
        info['gpu_memory_bytes']=torch.cuda.get_device_properties(0).total_memory
    dump(ROOT/'reports'/'environment.json',info)
    (ROOT/'reports'/'requirements-lock.txt').write_text(subprocess.check_output([sys.executable,'-m','pip','freeze'],text=True),encoding='utf-8')
    print(json.dumps(info,indent=2),flush=True)
    return info

def export_metrics(metrics,mod,phase,split,run_dir,weights_hash):
    box=metrics.box
    summary={'modality':mod,'phase':phase,'split':split,'status':'completed','precision':float(box.mp),'recall':float(box.mr),'mAP50':float(box.map50),'mAP50_95':float(box.map),'initial_weight_sha256':weights_hash,'run_dir':str(run_dir),'evaluation':'Ultralytics OBB ProbIoU similarity; AP thresholds 0.50:0.05:0.95; not official DroneVehicle/DOTA polygon evaluator'}
    if phase=='full':
        execution=json.loads((ROOT/'reports'/f'full_{mod}_execution.json').read_text(encoding='utf-8'))
        summary.update(comparison_epochs=full_budget()[0],actual_training_epochs=execution['epochs_completed'],schedule_epochs=full_budget()[1],selection_record=execution.get('selection_record'))
    if hasattr(metrics,'nt_per_class') and metrics.nt_per_class is not None:
        summary['evaluated_targets_per_class']=[int(v) for v in metrics.nt_per_class]
    per=[]
    for k,cls in enumerate(box.ap_class_index.tolist()):
        per.append({'class_id':int(cls),'name':metrics.names[int(cls)],'precision':float(box.p[k]),'recall':float(box.r[k]),'AP50':float(box.ap50[k]),'AP50_95':float(box.ap[k])})
    dump(ROOT/'reports'/f'{phase}_{mod}_{split}_metrics.json',{'summary':summary,'per_class':per,'classes_without_ground_truth':'omitted, never replaced by zero'})
    return summary

def execute(args):
    from ultralytics import YOLO, settings
    import torch
    settings.update({'sync':False,'wandb':False,'mlflow':False,'comet':False,'clearml':False,'neptune':False})
    info=probe()
    if not info['cuda_available']: raise RuntimeError('GPU unavailable. No long CPU training will be started.')
    readiness=json.loads((ROOT/'reports'/'readiness.json').read_text())
    if args.phase=='full' and not readiness['official_val_ready']:
        raise RuntimeError('Official validation split missing. Full baseline training/model selection is blocked.')
    if args.action=='test' and (args.phase!='full' or not readiness['official_test_ready']):
        raise RuntimeError('Official test split is required. Smoke data must never be reported as test.')
    if args.action=='test':
        frozen_path=ROOT/'reports'/'model_selection_frozen.json'
        if not frozen_path.is_file(): raise RuntimeError('Freeze both selected models and settings before testing.')
        frozen=json.loads(frozen_path.read_text(encoding='utf-8'))
        selected=ROOT/'weights'/f'full_{args.modality}'/'best.pt'
        if hashlib.sha256(selected.read_bytes()).hexdigest()!=frozen['models'][args.modality]['best_sha256']:
            raise RuntimeError('Selected weights changed after freeze; refusing test evaluation.')
        cfg=ROOT/'configs'/f'full_{args.modality}_requested.json'
        if hashlib.sha256(cfg.read_bytes()).hexdigest()!=frozen['models'][args.modality]['requested_config_sha256']:
            raise RuntimeError('Training configuration changed after freeze; refusing test evaluation.')
        if hashlib.sha256((ROOT/'reports'/'manifest.csv').read_bytes()).hexdigest()!=frozen['manifest_sha256']:
            raise RuntimeError('Dataset manifest changed after freeze; refusing test evaluation.')
    weights=ROOT/'weights'/'initial'/'yolov8n-obb.pt'
    if not weights.is_file(): raise FileNotFoundError(weights)
    weight_hash=hashlib.sha256(weights.read_bytes()).hexdigest()
    phasesuffix='_smoke' if args.phase=='smoke' else ''
    data=ROOT/'configs'/f'{args.modality}{phasesuffix}.yaml'
    run_name=f'{args.phase}_{args.modality}'
    if args.action=='train' and (ROOT/'runs'/run_name).exists():
        raise FileExistsError(f'{run_name} exists; preserve it and use --action resume only for an interrupted run')
    common=dict(data=str(data),epochs=2 if args.phase=='smoke' else 100,imgsz=640,batch=8,device=0,seed=42,deterministic=True,workers=0,optimizer='SGD',lr0=0.01,momentum=0.937,weight_decay=0.0005,patience=0,amp=False,cache=False,rect=False,mosaic=0.0,mixup=0.0,copy_paste=0.0,hsv_h=0.0,hsv_s=0.0,hsv_v=0.0,degrees=0.0,translate=0.1,scale=0.5,fliplr=0.5,flipud=0.0,close_mosaic=0,project=str(ROOT/'runs'),name=run_name,exist_ok=False,plots=True,save=True,save_period=10,verbose=True)
    if args.phase=='full':
        capacity_path=ROOT/'configs'/'full_training_capacity.json'
        if capacity_path.exists():
            capacity=json.loads(capacity_path.read_text(encoding='utf-8'))
            common.update({k:capacity[k] for k in ['batch','workers','amp']})
    target_epochs, schedule_epochs = (2, 2) if args.phase=='smoke' else full_budget()
    common['epochs']=target_epochs
    start=time.time(); torch.cuda.reset_peak_memory_stats()
    if args.action in ['train','resume']:
        dump(ROOT/'configs'/f'{run_name}_requested.json',{'initial_weights':str(weights),'initial_sha256':weight_hash,'training':common,'schedule_epochs':schedule_epochs,'epoch_budget_policy':'complete target epochs using unchanged schedule horizon','input_policy':'original 840x712; loader BGR->RGB; grayscale repeated to 3 channels; no radiometric conversion; no crop','claim':'self-built baseline; not UA-CMDet reproduction','scope':'debug only: train=64, eval=16 from official train' if args.phase=='smoke' else 'official train and official val'})
        if args.action=='resume':
            model=YOLO(str(ROOT/'runs'/run_name/'weights'/'last.pt'))
            if int(model.ckpt['train_args']['epochs']) != schedule_epochs:
                raise RuntimeError('Resume LR schedule horizon differs from the recorded experiment')
            attach_budget(model,target_epochs)
            model.train(resume=True)
        else:
            # A fresh object is loaded from the exact same initial file for each modality.
            model=YOLO(str(weights),task='obb')
            attach_budget(model,target_epochs)
            model.train(**{**common,'epochs':schedule_epochs})
        trained=Path(model.trainer.save_dir)
        with (trained/'results.csv').open(encoding='utf-8-sig') as f:
            history=list(csv.DictReader(f))
        if len(history)!=common['epochs']: raise RuntimeError('Requested training epochs were not completed')
        if not all(math.isfinite(float(row[k])) for row in history for k in ['train/box_loss','train/cls_loss','train/dfl_loss']):
            raise RuntimeError('Non-finite training loss recorded; inspect before evaluation')
        dest=ROOT/'weights'/run_name; dest.mkdir(parents=True,exist_ok=True)
        for name in ['best.pt','last.pt']:
            if (trained/'weights'/name).exists(): shutil.copy2(trained/'weights'/name,dest/name)
        dump(ROOT/'reports'/f'{run_name}_execution.json',{'elapsed_seconds':time.time()-start,'peak_cuda_allocated_bytes':torch.cuda.max_memory_allocated(),'run_dir':str(trained),'epochs_requested':common['epochs'],'comparison_epochs':target_epochs,'schedule_epochs':schedule_epochs,'epoch_budget_policy':'complete target epochs using unchanged schedule horizon','timing_scope':'current process segment only; see runtime_notes.json for interruptions and prior segments','epochs_completed':len(history),'finite_training_losses':True,'training_completed':True,'best_sha256':hashlib.sha256((dest/'best.pt').read_bytes()).hexdigest()})
    best=ROOT/'weights'/run_name/'best.pt'
    if not best.is_file(): raise FileNotFoundError('Best weights missing; train first')
    split='test' if args.action=='test' else 'val'
    # Testing is an explicit separate action after settings/model are frozen.
    model=YOLO(str(best),task='obb')
    evaluation_name=f'{run_name}_{split}_evaluation'
    counter=1
    while (ROOT/'runs'/evaluation_name).exists():
        counter+=1; evaluation_name=f'{run_name}_{split}_evaluation_{counter}'
    metrics=model.val(data=str(data),split=split,imgsz=640,batch=8,device=0,workers=0,conf=0.001,iou=0.7,max_det=300,plots=True,project=str(ROOT/'runs'),name=evaluation_name,exist_ok=False)
    label_split='debug_holdout_from_official_train' if args.phase=='smoke' else f'official_{split}'
    print(json.dumps(export_metrics(metrics,args.modality,args.phase,label_split,ROOT/'runs'/evaluation_name,weight_hash),indent=2),flush=True)
    if args.phase=='smoke':
        sample=json.loads((ROOT/'configs'/'smoke_ids.json').read_text())['eval'][:4]
        source=[str(ROOT/'data'/args.modality/'images'/'train'/f'{stem}.jpg') for stem in sample]
    else:
        source=[str(p) for p in sorted((ROOT/'data'/args.modality/'images'/split).glob('*.jpg'))[:4]]
    model.predict(source=source,imgsz=640,device=0,conf=0.25,iou=0.7,save=True,save_txt=True,save_conf=True,project=str(ROOT/'visualizations'/'predictions'),name=f'{run_name}_{split}',exist_ok=False)

if __name__=='__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    p=argparse.ArgumentParser(); p.add_argument('--probe',action='store_true'); p.add_argument('--modality',choices=['rgb','thermal']); p.add_argument('--phase',choices=['smoke','full'],default='smoke'); p.add_argument('--action',choices=['train','resume','val','test'],default='train')
    args=p.parse_args()
    if args.probe: probe()
    else:
        if not args.modality: p.error('--modality required')
        execute(args)
