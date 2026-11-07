"""Use the venv's matching base interpreter with its pinned task dependencies.

Windows-installed venv launchers may have a Low integrity label. Using the
ordinary configured base executable avoids propagating that label into the
native editor compiler. No ACL, token, or process-privilege setting is changed.
"""
from pathlib import Path
import runpy
import sys
from plcdev_environment import tool_path

ROOT = Path(__file__).resolve().parent.parent
VENV = tool_path('pythonEnvironment')


def configuration():
    values = {}
    for line in (VENV / 'pyvenv.cfg').read_text(encoding='utf-8').splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    return values


def interpreter():
    values = configuration()
    executable = tool_path('python')
    if not executable.is_absolute() or not executable.is_file():
        raise RuntimeError('Task environment base Python is missing; recreate the pinned environment.')
    return executable


def main():
    expected = tuple(int(part) for part in configuration()['version'].split('.')[:2])
    if sys.version_info[:2] != expected:
        raise RuntimeError('Task environment Python version differs; recreate the pinned environment.')
    dependencies = VENV / 'Lib/site-packages'
    if not dependencies.is_dir():
        raise RuntimeError('Pinned task dependencies are missing.')
    # This is private to this process, not a global Python installation change.
    sys.path.insert(0, str(dependencies))
    target = Path(__file__).with_name('agent_task_service.py')
    sys.argv[0] = str(target)
    runpy.run_path(str(target), run_name='__main__')


if __name__ == '__main__':
    main()
