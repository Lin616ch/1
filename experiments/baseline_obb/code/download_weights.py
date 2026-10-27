from pathlib import Path
import hashlib,json,urllib.request
root=Path(__file__).resolve().parents[1]
url='https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n-obb.pt'
dest=root/'weights'/'initial'/'yolov8n-obb.pt'
dest.parent.mkdir(parents=True,exist_ok=True)
if not dest.exists():
    temp=dest.with_suffix('.download'); urllib.request.urlretrieve(url,temp); temp.replace(dest)
record={'url':url,'bytes':dest.stat().st_size,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'model':'YOLOv8n-OBB','pretraining':'DOTA; official Ultralytics release asset','initialization_policy':'both modalities independently load this identical file'}
(dest.parent/'provenance.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
print(json.dumps(record,indent=2))
