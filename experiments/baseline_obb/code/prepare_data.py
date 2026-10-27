"""Read-only source audit and deterministic YOLO OBB export. No split is invented."""
import argparse, csv, hashlib, io, json, math, random, shutil
from pathlib import Path
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image, ImageDraw, ImageFont

NAMES = ['car', 'truck', 'bus', 'van', 'freight_car']
ALIASES = {'feright car':'freight_car','feright_car':'freight_car',
           'feright':'freight_car','truvk':'truck','freight car':'freight_car'}
MODS={'rgb':('img','label'), 'thermal':('imgr','labelr')}

def sha(data): return hashlib.sha256(data).hexdigest()
def write_json(p,obj):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8')
def csv_write(p,rows,fields):
    p.parent.mkdir(parents=True,exist_ok=True)
    with p.open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=fields); w.writeheader(); w.writerows(rows)

def order_quad(points):
    p=np.asarray(points,dtype=float)
    if p.shape!=(4,2) or not np.isfinite(p).all(): raise ValueError('invalid_coordinates')
    if len(set(map(tuple,p)))!=4: raise ValueError('repeated_vertex')
    center=p.mean(axis=0)
    p=p[np.argsort(np.arctan2(p[:,1]-center[1],p[:,0]-center[0]))]
    cross=[]
    for i in range(4):
        a=p[(i+1)%4]-p[i]; b=p[(i+2)%4]-p[(i+1)%4]
        cross.append(a[0]*b[1]-a[1]*b[0])
    if min(cross)<=1e-8: raise ValueError('nonconvex_or_degenerate_quad')
    start=min(range(4),key=lambda i:(p[i,1],p[i,0]))
    return np.roll(p,-start,axis=0)

def inspect_one(task):
    split,mod,stem,img,xml=task
    events=[]; labels=[]; hashes={}; meta={}; fatal=False
    def event(reason,action='quarantine_pair',obj='',detail=''):
        nonlocal fatal
        events.append(dict(split=split,modality=mod,id=stem,object_index=obj,reason=reason,action=action,detail=detail))
        if action=='quarantine_pair': fatal=True
    if img is None: event('missing_image')
    if xml is None: event('missing_xml')
    if img is None or xml is None: return dict(fatal=fatal,events=events,labels=labels,hashes=hashes,meta=meta)
    try:
        raw=img.read_bytes(); hashes['image_sha256']=sha(raw)
        with Image.open(io.BytesIO(raw)) as im:
            im.load(); w,h=im.size; meta['mode']=im.mode
            rgb=np.asarray(im.convert('RGB'))
        meta['width']=w; meta['height']=h
        # Explicit evidence for border policy; the image itself is never cropped.
        if (w,h)==(840,712):
            border=np.concatenate([rgb[:100].reshape(-1,3),rgb[-100:].reshape(-1,3),rgb[100:-100,:100].reshape(-1,3),rgb[100:-100,-100:].reshape(-1,3)])
            meta['border_white_fraction']=float(np.mean(np.min(border,axis=1)>=245))
        else: event('unexpected_image_size',detail=str((w,h)))
    except Exception as e:
        event('image_decode_failure',detail=str(e)); return dict(fatal=fatal,events=events,labels=labels,hashes=hashes,meta=meta)
    try:
        rawxml=xml.read_bytes(); hashes['xml_sha256']=sha(rawxml); root=ET.fromstring(rawxml)
        if (int(root.findtext('size/width')),int(root.findtext('size/height')))!=(w,h): event('xml_size_mismatch')
    except Exception as e:
        event('xml_parse_failure',detail=str(e)); return dict(fatal=fatal,events=events,labels=labels,hashes=hashes,meta=meta)
    raw_classes=Counter(); formats=Counter(); seen=set()
    for i,obj in enumerate(root.findall('object')):
        name=obj.findtext('name','').strip(); raw_classes[name]+=1
        canonical=ALIASES.get(name,name)
        if canonical!=name: event('class_alias','map_alias',i,f'{name} -> {canonical}')
        if canonical not in NAMES: event('unknown_class',obj=i,detail=name); continue
        poly=obj.find('polygon'); box=obj.find('bndbox')
        try:
            if poly is not None:
                formats['polygon']+=1
                pts=[(float(poly.findtext(f'x{j}')),float(poly.findtext(f'y{j}'))) for j in range(1,5)]
            elif box is not None:
                formats['bndbox']+=1
                a,b,c,d=[float(box.findtext(k)) for k in ['xmin','ymin','xmax','ymax']]
                if c<=a or d<=b: raise ValueError('degenerate_bndbox')
                pts=[(a,b),(c,b),(c,d),(a,d)]
            elif obj.find('point') is not None:
                formats['point']+=1; raise ValueError('point_has_no_extent')
            else: raise ValueError('unknown_geometry')
            q=order_quad(pts)
            if np.any(q<0) or np.any(q[:,0]>w) or np.any(q[:,1]>h): raise ValueError('out_of_image_quad')
            # Keep original 840x712 image and coordinates. No -100 or vertex clipping.
            q=q/np.array([w,h]); row=str(NAMES.index(canonical))+' '+' '.join(f'{v:.8f}' for v in q.ravel())
            if row in seen: event('duplicate_label','remove_exact_duplicate',i); continue
            seen.add(row); labels.append(row)
        except (TypeError,ValueError) as e: event(str(e),obj=i)
    meta['raw_classes']=dict(raw_classes); meta['formats']=dict(formats); meta['original_objects']=sum(raw_classes.values())
    return dict(fatal=fatal,events=events,labels=labels,hashes=hashes,meta=meta)

def find_root(root,split):
    for p in [root,root/split]:
        if (p/(split+'img')).is_dir(): return p
    raise ValueError(f'{root}: expected {split}img/{split}imgr/{split}label/{split}labelr')

def overlay(image,label,out):
    im=Image.open(image).convert('RGB'); d=ImageDraw.Draw(im)
    font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',15)
    colors=['#ff4545','#00e5ff','#ffdc00','#38ed77','#d76aff']
    for line in label.read_text().splitlines():
        values=line.split(); c=int(values[0]); q=np.array(list(map(float,values[1:]))).reshape(4,2)*im.size
        pts=[tuple(v) for v in q]; d.line(pts+[pts[0]],fill=colors[c],width=3)
        x,y=pts[0]; txt=NAMES[c]; bb=d.textbbox((x,y),txt,font=font)
        d.rectangle(bb,fill='black'); d.text((x,y),txt,font=font,fill=colors[c])
    out.parent.mkdir(parents=True,exist_ok=True); im.save(out)

def run(args):
    out=Path(args.output).resolve(); out.mkdir(parents=True,exist_ok=True)
    write_json(out/'reports'/'readiness.json',{'processed_splits':[],'official_val_ready':False,'official_test_ready':False,'status':'preprocessing_in_progress'})
    manifest=[]; events=[]; statistics=[]; all_meta={}; processed={}
    for split in ['train','val','test']:
        src=getattr(args,split)
        if not src:
            for mod in MODS: statistics.append(dict(split=split,modality=mod,status='missing',source_images='',exported_images='',quarantined_pairs='',objects='',**{n:'' for n in NAMES}))
            continue
        root=find_root(Path(src),split); tasks=[]; files={}; ids=set()
        for mod,(ip,lp) in MODS.items():
            images={p.stem:p for p in (root/(split+ip)).glob('*') if p.suffix.lower() in ['.jpg','.jpeg','.png']}
            xmls={p.stem:p for p in (root/(split+lp)).glob('*.xml')}
            files[mod]=(images,xmls); ids.update(images); ids.update(xmls)
        for stem in sorted(ids):
            for mod in MODS:
                images,xmls=files[mod]; tasks.append((split,mod,stem,images.get(stem),xmls.get(stem)))
        results={}
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for i,(task,res) in enumerate(zip(tasks,pool.map(inspect_one,tasks)),1):
                results[(task[1],task[2])]=res; events.extend(res['events'])
                if i%4000==0: print(f'{split}: decoded and parsed {i}/{len(tasks)}',flush=True)
        bad={stem for stem in ids if any(results[(mod,stem)]['fatal'] for mod in MODS)}
        for mod in MODS:
            imgdest=out/'data'/mod/'images'/split; labeldest=out/'data'/mod/'labels'/split
            imgdest.mkdir(parents=True,exist_ok=True); labeldest.mkdir(parents=True,exist_ok=True)
            classcount=Counter(); empty=0
            for stem in sorted(ids):
                res=results[(mod,stem)]; all_meta[f'{split}/{mod}/{stem}']=res['meta']
                rec=dict(split=split,modality=mod,id=stem,status='quarantined' if stem in bad else 'exported',**res['hashes'])
                manifest.append(rec)
                if stem in bad:
                    if not res['fatal']: events.append(dict(split=split,modality=mod,id=stem,object_index='',reason='paired_modality_invalid',action='quarantine_pair',detail='same paired ID excluded in both modalities'))
                    continue
                source=files[mod][0][stem]; dest=imgdest/(stem+source.suffix.lower())
                if not dest.exists() or sha(dest.read_bytes())!=res['hashes']['image_sha256']: shutil.copy2(source,dest)
                if sha(dest.read_bytes())!=res['hashes']['image_sha256']: raise RuntimeError('Copy hash mismatch')
                labels=res['labels']; (labeldest/(stem+'.txt')).write_text('\n'.join(labels)+ ('\n' if labels else ''),encoding='utf-8')
                for row in labels: classcount[NAMES[int(row.split()[0])]]+=1
                empty+=not labels
            statistics.append(dict(split=split,modality=mod,status='processed',source_images=len(files[mod][0]),exported_images=len(ids-bad),quarantined_pairs=len(bad),objects=sum(classcount.values()),**{n:classcount[n] for n in NAMES}))
            print(split,mod,'exported',len(ids-bad),'quarantine',len(bad),'empty',empty,flush=True)
        processed[split]=sorted(ids-bad)
    csv_write(out/'reports'/'manifest.csv',manifest,['split','modality','id','status','image_sha256','xml_sha256'])
    csv_write(out/'reports'/'events.csv',events,['split','modality','id','object_index','reason','action','detail'])
    csv_write(out/'reports'/'dataset_statistics.csv',statistics,['split','modality','status','source_images','exported_images','quarantined_pairs','objects']+NAMES)
    write_json(out/'reports'/'image_audit.json',all_meta)
    write_json(out/'reports'/'processing_summary.json',{'statistics':statistics,'events':dict(Counter(e['reason'] for e in events)),'quarantine_ids':sorted({e['id'] for e in events if e['action']=='quarantine_pair'}),'border_policy':'preserve_original_840x712_no_coordinate_shift','seed':args.seed})
    write_json(out/'configs'/'class_mapping.json',{'names':dict(enumerate(NAMES)),'aliases':ALIASES,'unknown_policy':'quarantine_both_modalities','point_policy':'quarantine_both_modalities','box_policy':'axis_aligned_box_to_four_vertices','polygon_policy':'order_convex_vertices_preserve_coordinates'})
    # Never assign train as official val/test. Full-run script checks readiness.
    for mod in MODS:
        text=f'path: {json.dumps((out/"data"/mod).as_posix())}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n'+''.join(f'  {i}: {n}\n' for i,n in enumerate(NAMES))
        (out/'configs'/f'{mod}.yaml').write_text(text,encoding='utf-8')
    # Smoke subsets stay in official train. Not official validation or test results.
    if 'train' in processed:
        rng=random.Random(args.seed); sampled=rng.sample(processed['train'],min(80,len(processed['train'])))
        smoke_train,smoke_eval=sampled[:64],sampled[64:80]
        write_json(out/'configs'/'smoke_ids.json',{'origin':'official_train_debug_only','train':smoke_train,'eval':smoke_eval,'seed':args.seed})
        preview=sorted(set(rng.sample(processed['train'],min(6,len(processed['train'])))+['00001','11663','16318']))
        write_json(out/'configs'/'preview_ids.json',preview)
        for mod in MODS:
            for part,items in [('train',smoke_train),('eval',smoke_eval)]:
                (out/'configs'/f'{mod}_smoke_{part}.txt').write_text('\n'.join((out/'data'/mod/'images'/'train'/(stem+'.jpg')).as_posix() for stem in items)+'\n',encoding='utf-8')
            text=f'path: {json.dumps((out/"data"/mod).as_posix())}\ntrain: {json.dumps((out/"configs"/f"{mod}_smoke_train.txt").as_posix())}\nval: {json.dumps((out/"configs"/f"{mod}_smoke_eval.txt").as_posix())}\nnames:\n'+''.join(f'  {i}: {n}\n' for i,n in enumerate(NAMES))
            (out/'configs'/f'{mod}_smoke.yaml').write_text(text,encoding='utf-8')
            for stem in preview:
                if stem in processed['train']: overlay(out/'data'/mod/'images'/'train'/(stem+'.jpg'),out/'data'/mod/'labels'/'train'/(stem+'.txt'),out/'visualizations'/'labels'/f'{mod}_{stem}.jpg')
    # Exact content duplicate leakage check, scoped within each modality.
    overlaps=[]; known={}
    for row in manifest:
        if row['status']!='exported': continue
        key=(row['modality'],row['image_sha256'])
        if key in known and known[key]['split']!=row['split']: overlaps.append({'first':known[key],'second':row})
        known[key]=row
    write_json(out/'reports'/'cross_split_exact_duplicates.json',overlaps)
    if overlaps: raise RuntimeError('Cross-split exact image duplicates found; inspect before training')
    write_json(out/'reports'/'readiness.json',{'processed_splits':list(processed),'official_val_ready':'val' in processed,'official_test_ready':'test' in processed,'leakage_exact_hash_check':'passed','semantic_near_duplicate_check':'not_performed','smoke_is_not_baseline':True})
    print('DONE',out,flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--train',required=True); p.add_argument('--val'); p.add_argument('--test'); p.add_argument('--output',required=True); p.add_argument('--seed',type=int,default=42); p.add_argument('--workers',type=int,default=4)
    run(p.parse_args())
