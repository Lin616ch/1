"""Explicit epoch cap independent of the unchanged LR schedule horizon."""
import json
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def full_budget():
    config = json.loads((ROOT / 'configs/full_training_capacity.json').read_text(encoding='utf-8'))
    target = int(config['epochs'])
    horizon = int(config.get('schedule_epochs', target))
    if not 0 < target <= horizon:
        raise ValueError('Epoch budget must be positive and no greater than LR schedule horizon')
    return target, horizon

def stop_at_budget(trainer, target):
    completed = trainer.epoch + 1
    if completed > target:
        raise RuntimeError('Epoch budget exceeded')
    if completed == target:
        # Called before validation/checkpoint saving. Normal final_eval still runs.
        trainer.stop = True

def attach_budget(model, target):
    model.add_callback('on_train_epoch_end', lambda trainer: stop_at_budget(trainer, target))

def verify_comparison_history(modality, history, execution):
    """Allow an audited saved prefix without rewriting a longer source history."""
    target, horizon = full_budget()
    assert execution.get('comparison_epochs', execution['epochs_completed']) == target
    assert execution['epochs_completed'] == len(history) >= target
    assert execution['schedule_epochs'] == horizon
    if len(history) > target:
        record = json.loads((ROOT / execution['selection_record']).read_text(encoding='utf-8'))
        assert record['modality'] == modality
        assert record['selection_window_epochs'] == target
        assert record['actual_training_history_epochs'] == len(history)
        assert record['selected_best_epoch_one_based'] <= target
        assert record['best_sha256'] == execution['best_sha256']
        assert record['prefix_history_sha256'] == hashlib.sha256(json.dumps(history[:target], sort_keys=True).encode()).hexdigest()
