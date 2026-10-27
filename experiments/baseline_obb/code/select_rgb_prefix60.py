"""One-time audited selection of the saved RGB best model from its first 60 epochs.

Preserves the full 80-epoch history and outputs. No source data or test metrics
are changed. Fresh reproductions simply train both modalities for 60 epochs.
"""
import csv, datetime, hashlib, json, shutil
from pathlib import Path
import torch

ROOT = Path(__file__).resolve().parents[1]

def load(path):
    return json.loads(path.read_text(encoding='utf-8'))

def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def main():
    record_path = ROOT/'reports/rgb_prefix60_selection.json'
    if record_path.exists():
        raise RuntimeError('Selection already applied; preserve the original record')
    assert not (ROOT/'reports/model_selection_frozen.json').exists()
    assert not list((ROOT/'reports').glob('full_*_official_test_metrics.json'))
    history = list(csv.DictReader((ROOT/'runs/full_rgb/results.csv').open(encoding='utf-8-sig')))
    assert len(history) == 80
    source = ROOT.parent.parent/'work/budget_change/20261019T103740Z'
    best = torch.load(source/'best.pt', map_location='cpu', weights_only=False)
    last = torch.load(source/'last.pt', map_location='cpu', weights_only=False)
    assert last['epoch'] == 59 and best['epoch'] < 60
    prefix_best = max(history[:60], key=lambda row: float(row['metrics/mAP50-95(B)']))
    assert int(prefix_best['epoch']) == best['epoch'] + 1
    assert abs(float(prefix_best['metrics/mAP50-95(B)']) - best['best_fitness']) < 1e-4
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    archive = ROOT/'reports/archive_rgb80'
    archive.mkdir()
    for rel in ['reports/full_rgb_execution.json', 'reports/full_rgb_official_val_metrics.json',
                'configs/full_rgb_requested.json', 'configs/full_training_capacity.json',
                'reports/full_pipeline_status.json', 'reports/training_budget_change.json']:
        shutil.copy2(ROOT/rel, archive/Path(rel).name)
    shutil.copytree(ROOT/'code', archive/'code_before_60', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(ROOT/'weights/full_rgb', ROOT/'weights/rgb_completed80')
    shutil.copy2(ROOT/'logs/full_thermal.log', ROOT/f'logs/full_thermal_before_60_{stamp}.log')
    execution = load(ROOT/'reports/full_rgb_execution.json')
    cfg = load(ROOT/'configs/full_rgb_requested.json')
    for name in ['best.pt', 'last.pt']:
        shutil.copy2(source/name, ROOT/'weights/full_rgb'/name)
    selection = {
        'selected_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'authorization': 'User selected 改为两路60轮对比，优先交付',
        'modality': 'rgb', 'actual_training_history_epochs': 80,
        'selection_window_epochs': 60, 'selected_best_epoch_one_based': best['epoch']+1,
        'selection_metric': 'official val Ultralytics OBB fitness (mAP50:95)',
        'saved_prefix_best_fitness': best['best_fitness'],
        'best_sha256': digest(ROOT/'weights/full_rgb/best.pt'),
        'last_sha256': digest(ROOT/'weights/full_rgb/last.pt'),
        'prefix_history_sha256': hashlib.sha256(json.dumps(history[:60], sort_keys=True).encode()).hexdigest(),
        'original_80_epoch_weights': 'weights/rgb_completed80',
        'original_80_epoch_history': 'runs/full_rgb/results.csv',
        'original_80_epoch_reports': 'reports/archive_rgb80',
        'source_checkpoint_archive': str(source),
        'policy': 'Select saved best from first60 validation results. Epochs61-80 and test scores are excluded from model selection; actual 80-epoch history remains intact.'
    }
    dump(record_path, selection)
    cfg['training']['epochs'] = 60
    cfg.update(actual_training_history_epochs=80, comparison_epochs=60,
               selection_record='reports/rgb_prefix60_selection.json')
    dump(ROOT/'configs/full_rgb_requested.json', cfg)
    execution.update(comparison_epochs=60, best_sha256=selection['best_sha256'],
                     weights_scope='saved best/last from first60; full training history has80 epochs',
                     selection_record='reports/rgb_prefix60_selection.json')
    dump(ROOT/'reports/full_rgb_execution.json', execution)
    # The new selected weights must receive a fresh independent validation.
    (ROOT/'reports/full_rgb_official_val_metrics.json').unlink()
    capacity = load(ROOT/'configs/full_training_capacity.json')
    capacity.update(epochs=60, schedule_epochs=100, budget_change_record='reports/comparison_budget60_change.json')
    dump(ROOT/'configs/full_training_capacity.json', capacity)
    dump(ROOT/'reports/comparison_budget60_change.json', {
        'authorized_utc': selection['selected_utc'], 'authorization': selection['authorization'],
        'comparison_epochs': 60, 'schedule_epochs': 100,
        'rgb_actual_training_epochs': 80, 'rgb_selection': 'reports/rgb_prefix60_selection.json',
        'thermal_policy': 'continue its independent pretrained run; stop after exactly60 completed epochs',
        'test_used_for_budget_or_selection': False
    })
    state = load(ROOT/'reports/full_pipeline_status.json')
    state.update(status='interrupted', stage='authorized_comparison_budget_60', updated_utc=selection['selected_utc'])
    dump(ROOT/'reports/full_pipeline_status.json', state)
    print(json.dumps(selection, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
