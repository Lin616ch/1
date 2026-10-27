"""Validate all official exported splits and save deterministic label previews."""
import csv,json,random,hashlib
from pathlib import Path
import numpy as np
from prepare_data import overlay,write_json,NAMES
ROOT=Path(__file__).resolve().parents[1]
def main():
    readiness=json.loads((ROOT/'reports/readiness.json').read_text())
    assert readiness['official_val_ready'] and readiness['official_test_ready']
    assert json.loads((ROOT/'reports/cross_split_exact_duplicates.json').read_text())==[]
    with (ROOT/'reports/manifest.csv').open(encoding='utf-8-sig') as f: manifest=list(csv.DictReader(f))
    rows=[]; common={}
    for split in ['train','val','test']:
        sets=[]
        for mod in ['rgb','thermal']:
            expected={r['id'] for r in manifest if r['split']==split and r['modality']==mod and r['status']=='exported'}
            images={p.stem for p in (ROOT/'data'/mod/'images'/split).glob('*.jpg')}
            labels={p.stem for p in (ROOT/'data'/mod/'labels'/split).glob('*.txt')}
            assert expected==images==labels, f'Unexpected extra or missing exports: {split}/{mod}'
            counts=[0]*5;empty=0
            for stem in sorted(labels):
                lines=(ROOT/'data'/mod/'labels'/split/f'{stem}.txt').read_text().splitlines()
                empty+=not lines
                for line in lines:
                    x=line.split();assert len(x)==9 and int(x[0]) in range(5)
                    q=np.array(list(map(float,x[1:]))).reshape(4,2)
                    assert np.isfinite(q).all() and (q>=0).all() and (q<=1).all()
                    area=abs(sum(q[i,0]*q[(i+1)%4,1]-q[(i+1)%4,0]*q[i,1] for i in range(4)))
                    assert area>0
                    counts[int(x[0])]+=1
            sets.append(expected)
            rows.append(dict(split=split,modality=mod,images=len(images),empty_labels=empty,objects=sum(counts),**dict(zip(NAMES,counts))))
        assert sets[0]==sets[1]
        common[split]=sorted(sets[0])
    rng=random.Random(42)
    previews={split:sorted(rng.sample(ids,min(4,len(ids)))) for split,ids in common.items()}
    write_json(ROOT/'configs'/'official_preview_ids.json',{'seed':42,'ids_selected_before_training_and_prediction':True,'splits':previews})
    for split in ['val','test']:
        for stem in previews[split]:
            for mod in ['rgb','thermal']:
                overlay(ROOT/'data'/mod/'images'/split/f'{stem}.jpg',ROOT/'data'/mod/'labels'/split/f'{stem}.txt',ROOT/'visualizations'/'labels'/f'{split}_{mod}_{stem}.jpg')
    write_json(ROOT/'reports'/'official_export_validation.json',{'passed':True,'splits':rows,'exact_cross_split_image_duplicates':0,'label_format':'class + 8 normalized corner coordinates','manifest_sha256':hashlib.sha256((ROOT/'reports/manifest.csv').read_bytes()).hexdigest(),'preview_ids':previews})
    print(json.dumps(rows,ensure_ascii=False,indent=2),flush=True)
if __name__=='__main__': main()
