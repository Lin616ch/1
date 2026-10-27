"""Paired scene diagnostics at conf=.25 and exact polygon IoU=.50 (not headline AP)."""
import argparse,os,json,csv
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
os.environ['YOLO_CONFIG_DIR']=str(ROOT/'configs'/'ultralytics_settings')
os.environ['MPLCONFIGDIR']=str(ROOT/'configs'/'matplotlib')
from ultralytics import YOLO
from PIL import Image,ImageDraw,ImageFont
import cv2,numpy as np

def poly_iou(a,b):
    a=cv2.convexHull(np.asarray(a,dtype=np.float32));b=cv2.convexHull(np.asarray(b,dtype=np.float32))
    inter,_=cv2.intersectConvexConvex(a,b)
    union=cv2.contourArea(a)+cv2.contourArea(b)-inter
    return float(inter/union) if union>0 else 0.

def main(phase='smoke'):
    full=phase=='full'
    if full:
        assert (ROOT/'reports/model_selection_frozen.json').is_file()
        assert all((ROOT/'reports'/f'full_{mod}_official_test_metrics.json').is_file() for mod in ['rgb','thermal'])
        ids=json.loads((ROOT/'configs/official_preview_ids.json').read_text())['splits']['test']
    else: ids=json.loads((ROOT/'configs'/'smoke_ids.json').read_text())['eval'][:4]
    split='test' if full else 'train'
    prefix='full_' if full else ''
    out=ROOT/'visualizations'/('full_diagnostics' if full else 'diagnostics');out.mkdir(parents=True,exist_ok=True)
    rows=[]; font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',15)
    for mod in ['rgb','thermal']:
        model=YOLO(str(ROOT/'weights'/f'{phase}_{mod}'/'best.pt'))
        for stem in ids:
            ip=ROOT/'data'/mod/'images'/split/f'{stem}.jpg'
            im=Image.open(ip).convert('RGB'); w,h=im.size
            gt=[]
            for line in (ROOT/'data'/mod/'labels'/split/f'{stem}.txt').read_text().splitlines():
                vals=line.split();gt.append((int(vals[0]),np.array(list(map(float,vals[1:]))).reshape(4,2)*[w,h]))
            pred=model.predict(str(ip),imgsz=640,device=0,conf=0.25,iou=0.7,verbose=False)[0].obb
            boxes=pred.xyxyxyxy.cpu().numpy(); cls=pred.cls.int().cpu().numpy(); scores=pred.conf.cpu().numpy()
            matched=set(); tp=[];fp=[]
            for k in np.argsort(-scores):
                candidates=[(poly_iou(boxes[k],g[1]),j) for j,g in enumerate(gt) if j not in matched and g[0]==cls[k]]
                best=max(candidates,default=(0,-1))
                if best[0]>=0.5: matched.add(best[1]);tp.append(k)
                else: fp.append(k)
            fn=[j for j in range(len(gt)) if j not in matched]
            draw=ImageDraw.Draw(im)
            def plot(q,color,text):
                pts=[tuple(p) for p in q];draw.line(pts+[pts[0]],fill=color,width=3)
                pos=pts[0];draw.rectangle(draw.textbbox(pos,text,font=font),fill='black');draw.text(pos,text,fill=color,font=font)
            for j in fn: plot(gt[j][1],'#ff4040','FN '+model.names[gt[j][0]])
            for k in tp: plot(boxes[k],'#00c080','TP '+model.names[int(cls[k])])
            for k in fp: plot(boxes[k],'#ff9d00','FP '+model.names[int(cls[k])])
            im.save(out/f'{mod}_{stem}.jpg')
            rows.append(dict(modality=mod,id=stem,ground_truth=len(gt),predictions=len(boxes),TP=len(tp),FP=len(fp),FN=len(fn),confidence=0.25,matching='greedy_same_class_polygon_IoU_0.5',scope='official_test' if full else 'debug_holdout_from_official_train'))
    with (ROOT/'reports'/f'{prefix}paired_scene_diagnostics.csv').open('w',encoding='utf-8-sig',newline='') as f:
        wr=csv.DictWriter(f,fieldnames=list(rows[0]));wr.writeheader();wr.writerows(rows)
    (ROOT/'reports'/f'{prefix}paired_scene_diagnostics.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
    print(json.dumps(rows,indent=2))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--phase',choices=['smoke','full'],default='smoke')
    main(parser.parse_args().phase)
