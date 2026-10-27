"""Sequential official training -> model freeze -> independent test -> deliverables.

Status and logs persist locally. The test set is not used for training or selection.
"""
import csv,datetime,hashlib,json,os,subprocess,sys,traceback
from pathlib import Path
from training_budget import full_budget, verify_comparison_history
ROOT=Path(__file__).resolve().parents[1]
STATUS=ROOT/'reports'/'full_pipeline_status.json'
def digest(p):
    with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(value):
    value['updated_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    temp=STATUS.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(STATUS)
def command(script,args,log):
    with (ROOT/'logs'/log).open('w',encoding='utf-8') as f:
        proc=subprocess.run([sys.executable,str(ROOT/'code'/script),*args],stdout=f,stderr=subprocess.STDOUT,env=os.environ.copy())
    if proc.returncode:raise RuntimeError(f'{script} failed with code {proc.returncode}; see logs/{log}')
def freeze_models():
    existing=ROOT/'reports'/'model_selection_frozen.json'
    if existing.exists():
        record=json.loads(existing.read_text(encoding='utf-8'))
        for mod in ['rgb','thermal']:
            assert digest(ROOT/'weights'/f'full_{mod}'/'best.pt')==record['models'][mod]['best_sha256']
            assert digest(ROOT/'configs'/f'full_{mod}_requested.json')==record['models'][mod]['requested_config_sha256']
        assert digest(ROOT/'reports'/'manifest.csv')==record['manifest_sha256']
        return
    configs={};models={}
    for mod in ['rgb','thermal']:
        cfg=json.loads((ROOT/'configs'/f'full_{mod}_requested.json').read_text(encoding='utf-8'))
        hist=list(csv.DictReader((ROOT/'runs'/f'full_{mod}'/'results.csv').open(encoding='utf-8-sig')))
        execution=json.loads((ROOT/'reports'/f'full_{mod}_execution.json').read_text(encoding='utf-8'))
        verify_comparison_history(mod,hist,execution)
        assert cfg['training']['epochs']==full_budget()[0]
        assert digest(ROOT/'weights'/f'full_{mod}'/'best.pt')==execution['best_sha256']
        assert (ROOT/'reports'/f'full_{mod}_official_val_metrics.json').is_file()
        val_summary=json.loads((ROOT/'reports'/f'full_{mod}_official_val_metrics.json').read_text(encoding='utf-8'))['summary']
        assert val_summary['comparison_epochs']==full_budget()[0]
        configs[mod]=cfg
        models[mod]={'best_sha256':digest(ROOT/'weights'/f'full_{mod}'/'best.pt'),'requested_config_sha256':digest(ROOT/'configs'/f'full_{mod}_requested.json'),'actual_training_epochs':len(hist),'comparison_epochs':full_budget()[0],'selection_record':execution.get('selection_record')}
    differences={k:[configs['rgb']['training'][k],configs['thermal']['training'][k]] for k in configs['rgb']['training'] if configs['rgb']['training'][k]!=configs['thermal']['training'][k]}
    assert set(differences)=={'name','data'}
    assert configs['rgb']['initial_sha256']==configs['thermal']['initial_sha256']
    assert configs['rgb']['schedule_epochs']==configs['thermal']['schedule_epochs']==full_budget()[1]
    frozen={'frozen_before_test_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'models':models,'initial_sha256':configs['rgb']['initial_sha256'],'training_parameter_differences':differences,'comparison_epochs_per_modality':full_budget()[0],'schedule_epochs':full_budget()[1],'test_selection_policy':'No test performance has been used to choose model/configuration','manifest_sha256':digest(ROOT/'reports'/'manifest.csv')}
    (ROOT/'reports'/'model_selection_frozen.json').write_text(json.dumps(frozen,ensure_ascii=False,indent=2),encoding='utf-8')
def main():
    if STATUS.exists():
        prior=json.loads(STATUS.read_text(encoding='utf-8'))
        if prior.get('status') in ['completed','awaiting_review']:raise RuntimeError('Completed pipeline exists; preserve its outputs')
        if prior.get('status')=='running':raise RuntimeError('A pipeline is already marked running. Inspect it before starting another process.')
    state={'status':'running','stage':'starting','completed_stages':[],'pid':os.getpid()};write(state)
    try:
        for mod in ['rgb','thermal']:
            state['stage']=f'train_{mod}_{full_budget()[0]}_epochs';write(state)
            if (ROOT/'reports'/f'full_{mod}_official_val_metrics.json').exists():
                pass
            elif (ROOT/'weights'/f'full_{mod}'/'best.pt').exists():
                command('run_experiment.py',['--modality',mod,'--phase','full','--action','val'],f'full_{mod}_val_recovery.log')
            else:
                resume=(ROOT/'runs'/f'full_{mod}'/'weights'/'last.pt').is_file()
                command('run_experiment.py',['--modality',mod,'--phase','full','--action','resume' if resume else 'train'],f'full_{mod}.log')
            state['completed_stages'].append(f'train_{mod}');write(state)
        state['stage']='freeze_model_selection';write(state);freeze_models()
        for mod in ['rgb','thermal']:
            state['stage']=f'official_test_{mod}';write(state)
            if not (ROOT/'reports'/f'full_{mod}_official_test_metrics.json').exists():
                command('run_experiment.py',['--modality',mod,'--phase','full','--action','test'],f'full_{mod}_test.log')
            state['completed_stages'].append(f'test_{mod}');write(state)
        state['stage']='official_test_diagnostics';write(state)
        command('analyze_predictions.py',['--phase','full'], 'full_paired_diagnostics.log')
        state['stage']='final_report';write(state)
        command('finalize_full_results.py',[], 'finalize_full_report.log')
        state['stage']='formal_presentation';write(state)
        if not (ROOT/'DroneVehicle_正式汇报.pptx').exists():
            node=os.environ.get('CODEX_RUNTIME_NODE',r'C:\Users\32073\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
            with (ROOT/'logs'/'build_full_presentation.log').open('w',encoding='utf-8') as log:
                result=subprocess.run([node,str(ROOT/'code'/'build_full_presentation.mjs')],stdout=log,stderr=subprocess.STDOUT,env=os.environ.copy())
            if result.returncode:raise RuntimeError('Formal presentation build failed; see logs/build_full_presentation.log')
        state['stage']='package_formal_results';write(state)
        command('finalize_full_results.py',['--package'], 'package_full_results.log')
        state.update(status='awaiting_review',stage='training_evaluation_report_and_presentation_completed',presentation_pending=False,visual_review_pending=True)
        write(state)
    except Exception as e:
        state.update(status='failed',error=str(e),traceback=traceback.format_exc());write(state);raise
if __name__=='__main__':main()
