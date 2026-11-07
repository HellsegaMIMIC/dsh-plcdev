"""Cross-process lease for PLCdev-managed isolated Runtimes (not external PLCs)."""
from pathlib import Path
import json, os, time
from factoryio_runtime import ROOT, store
from plcdev_environment import runtime_owner_directory

LOCK = runtime_owner_directory() / 'runtime.lock'
INFO = LOCK.with_suffix('.json')

class FileLease:
    def __init__(self, path, timeout=0):
        self.path = Path(path); self.file = None; self.timeout=timeout

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = self.path.open('a+b')
        if self.file.seek(0, 2) == 0:
            self.file.write(b'0'); self.file.flush()
        self.file.seek(0)
        deadline=time.monotonic()+self.timeout
        while True:
            try:
                self.file.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic()<deadline:time.sleep(.05);continue
                self.file.close(); self.file = None
                raise RuntimeError('已有 PLCdev 会话占用 Runtime；请先在所属入口结束会话。') from None
        return self

    def __exit__(self, *args):
        if self.file:
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_UN)
            self.file.close(); self.file = None

def owner():
    try:
        with FileLease(LOCK): return None
    except OSError:
        # Status inspection must stay available when the global lease cannot
        # be inspected. A truthy unknown owner keeps preparation disabled;
        # never turn permission/IO errors into a claim that Runtime is free.
        return {'owner': 'Runtime 占用状态无法核验', 'state': 'unknown',
                'reason': '无法访问全局会话锁；已禁止准备运行，请检查本机目录权限。'}
    except RuntimeError:
        try: return json.loads(INFO.read_text(encoding='utf-8'))
        except (OSError, ValueError): return {'owner': '正在登记的 PLCdev 会话'}

class RuntimeLease(FileLease):
    def __init__(self, run_directory):
        super().__init__(LOCK); self.directory = Path(run_directory).resolve()

    def __enter__(self):
        super().__enter__()
        try:
            manifest = json.loads((self.directory/'session.json').read_text(encoding='utf-8'))
            store(INFO, {'pid': os.getpid(), 'runDirectory': str(self.directory),
                'sessionId': manifest['sessionId'], 'programHash': manifest['programHash'],
                'owner': 'PLCdev 工作台' if manifest.get('batchExample') else 'OpenPLC 编辑器／验证工具',
                'acquiredAt': time.time()})
        except Exception:
            super().__exit__(); raise
        return self
