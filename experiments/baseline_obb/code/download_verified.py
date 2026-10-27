"""Resume a public wheel download, then verify its official upstream SHA-256."""
import argparse,hashlib,time,urllib.request
from pathlib import Path

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--url',required=True); p.add_argument('--sha256',required=True); p.add_argument('--output',required=True)
    a=p.parse_args(); dest=Path(a.output); dest.parent.mkdir(parents=True,exist_ok=True); partial=dest.with_suffix(dest.suffix+'.part')
    if not dest.exists():
        for attempt in range(6):
            offset=partial.stat().st_size if partial.exists() else 0
            try:
                req=urllib.request.Request(a.url,headers={'Range':f'bytes={offset}-','User-Agent':'Python wheel download'})
                with urllib.request.urlopen(req,timeout=45) as response:
                    if offset and (response.status!=206 or not str(response.headers.get('Content-Range')).startswith(f'bytes {offset}-')):
                        raise RuntimeError('Server did not return the requested resume range')
                    print('response',response.status,response.headers.get('Content-Range'),flush=True)
                    last=offset
                    with partial.open('ab' if offset else 'wb') as f:
                        while True:
                            block=response.read(1024*128)
                            if not block: break
                            f.write(block); offset+=len(block)
                            if offset-last>=64*1024**2: print('downloaded_MiB',round(offset/1024**2,1),flush=True); last=offset
                break
            except Exception as e:
                print('attempt',attempt+1,repr(e),flush=True)
                if attempt==5: raise
                time.sleep(2)
        h=hashlib.file_digest(partial.open('rb'),'sha256').hexdigest()
        if h!=a.sha256: raise RuntimeError(f'SHA256 mismatch: {h}')
        partial.replace(dest)
    h=hashlib.file_digest(dest.open('rb'),'sha256').hexdigest()
    if h!=a.sha256: raise RuntimeError('Existing file hash mismatch')
    print('VERIFIED',dest,h,flush=True)
