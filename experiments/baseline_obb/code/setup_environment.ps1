param(
    [string]$EnvironmentPath = "$PSScriptRoot\..\..\..\work\venv",
    [string]$PyPIIndex = 'https://pypi.org/simple',
    [string]$TorchIndex = 'https://download.pytorch.org/whl/cu128'
)
$ErrorActionPreference = 'Stop'
python -m venv $EnvironmentPath
if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
$trainingPython = Join-Path $EnvironmentPath 'Scripts\python.exe'
& $trainingPython -m pip install --timeout 60 --retries 3 torch==2.7.1 torchvision==0.22.1 --index-url $TorchIndex --extra-index-url $PyPIIndex
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed' }
& $trainingPython -m pip install --timeout 60 --retries 3 ultralytics==8.3.200 numpy==2.2.6 opencv-python==4.12.0.88 pillow==11.3.0 --index-url $PyPIIndex
if ($LASTEXITCODE -ne 0) { throw 'Dependencies installation failed' }
& $trainingPython "$PSScriptRoot\download_weights.py"
& $trainingPython "$PSScriptRoot\run_experiment.py" --probe
