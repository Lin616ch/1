"""Train-only capacity/throughput preflight; never use these weights as a baseline."""
import argparse,json,os,random,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
os.environ['YOLO_CONFIG_DIR']=str(ROOT/'configs/ultralytics_settings')
os.environ['MPLCONFIGDIR']=str(ROOT/'configs/matplotlib')
os.environ['CUBLAS_WORKSPACE_CONFIG']=':4096:8'
os.environ['YOLO_AUTOINSTALL']='false'
def main(args):
    import torch
    from ultralytics import YOLO,settings
    settings.update({'sync':False,'wandb':False,'mlflow':False,'comet':False,'clearml':False,'neptune':False})
    source=ROOT/'data/rgb';rng=random.Random(42)
    exclude=set(json.loads((ROOT/'configs/smoke_ids.json').read_text())['eval'])
    labels=[p for p in (source/'labels/train').glob('*.txt') if p.stem not in exclude]
    counts={p.stem:len(p.read_text().splitlines()) for p in labels}
    dense=sorted(counts,key=lambda k:(-counts[k],k))[:64]
    selected=dense+rng.sample(sorted(set(counts)-set(dense)),192)
    manifest=ROOT/'configs/profile_training_ids.txt'
    manifest.write_text('\n'.join((source/'images/train'/f'{stem}.jpg').as_posix() for stem in selected)+'\n',encoding='utf-8')
    data=ROOT/'configs/profile_training.yaml'
    data.write_text(f'path: {json.dumps(source.as_posix())}\ntrain: {json.dumps(manifest.as_posix())}\nval: {json.dumps((ROOT/"configs/rgb_smoke_eval.txt").as_posix())}\nnames: [car, truck, bus, van, freight_car]\n',encoding='utf-8')
    intervals=[];last=[None];peak=[0];start=time.perf_counter()
    def before(trainer):
        torch.cuda.synchronize();now=time.perf_counter()
        if trainer.epoch==1 and last[0] is not None:intervals.append(now-last[0])
        last[0]=now
    def after(trainer):peak[0]=max(peak[0],torch.cuda.max_memory_allocated())
    model=YOLO(str(ROOT/'weights/initial/yolov8n-obb.pt'),task='obb')
    model.add_callback('on_train_batch_start',before);model.add_callback('on_train_batch_end',after)
    torch.cuda.reset_peak_memory_stats()
    model.train(data=str(data),epochs=2,imgsz=640,batch=args.batch,device=0,workers=args.workers,seed=42,deterministic=True,optimizer='SGD',lr0=0.01,amp=False,patience=0,cache=False,mosaic=0.0,mixup=0.0,copy_paste=0.0,hsv_h=0.0,hsv_s=0.0,hsv_v=0.0,degrees=0.0,translate=0.1,scale=0.5,fliplr=0.5,flipud=0.0,close_mosaic=0,project=str(ROOT/'runs'),name=f'profile_b{args.batch}_w{args.workers}',plots=False,save=False,val=False,verbose=False)
    usable=intervals[2:]
    result={'scope':'train-only throughput/capacity preflight; not a full baseline; weights not reused','batch':args.batch,'workers':args.workers,'amp':False,'images':len(selected),'dense_training_images':64,'max_original_objects':max(counts[k] for k in selected),'peak_cuda_allocated_bytes':peak[0],'second_epoch_batch_seconds':usable,'mean_batch_seconds':sum(usable)/len(usable) if usable else None,'elapsed_seconds':time.perf_counter()-start,'success':True}
    (ROOT/'reports'/f'profile_b{args.batch}_w{args.workers}.json').write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result,indent=2),flush=True)
if __name__=='__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    parser=argparse.ArgumentParser();parser.add_argument('--batch',type=int,default=16);parser.add_argument('--workers',type=int,default=4)
    main(parser.parse_args())
