"""Collect only observed metrics. Missing experiments remain empty, never zero."""
import csv,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def write_csv(p,rows,fields):
    with p.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore');writer.writeheader();writer.writerows(rows)
def collect():
    rows=[]; classes=[]
    for phase,split in [('smoke','debug_holdout_from_official_train'),('full','official_val'),('full','official_test')]:
        for mod in ['rgb','thermal']:
            file=ROOT/'reports'/f'{phase}_{mod}_{split}_metrics.json'
            if file.exists():
                r=load(file); rows.append(r['summary'])
                for item in r['per_class']: classes.append(dict(modality=mod,phase=phase,split=split,**item))
            else:
                rows.append(dict(modality=mod,phase=phase,split=split,status='not_run',reason='official_val_test_missing' if phase=='full' else 'environment_or_trial_pending'))
    write_csv(ROOT/'reports'/'experiment_comparison.csv',rows,['modality','phase','split','status','precision','recall','mAP50','mAP50_95','reason','comparison_epochs','actual_training_epochs','schedule_epochs','initial_weight_sha256','evaluation','run_dir'])
    write_csv(ROOT/'reports'/'per_class_AP.csv',classes,['modality','phase','split','class_id','name','precision','recall','AP50','AP50_95'])
    return rows
if __name__=='__main__':
    print(json.dumps(collect(),ensure_ascii=False,indent=2))
