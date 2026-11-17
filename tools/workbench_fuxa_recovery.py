"""Read-only discovery of the selected project's legacy FUXA preview.

The transaction belongs to FUXA, not a DSH conversation.  This module never
opens the editor, updates the journal, keeps/undoes a preview or starts Runtime.
"""
from __future__ import annotations

import hashlib
import json
import re
import os
from pathlib import Path

_UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
_HASH = re.compile(r'^[0-9a-f]{64}$')


def _read(path, limit):
    with path.open('rb') as stream:
        data=stream.read(limit+1)
    if len(data)>limit: raise ValueError('file too large')
    def unique(pairs):
        value={}
        for key,item in pairs:
            if key in value:raise ValueError('duplicate field')
            value[key]=item
        return value
    def invalid_constant(_):raise ValueError('non-JSON constant')
    return json.loads(data.decode('utf-8-sig'),object_pairs_hook=unique,parse_constant=invalid_constant)


def recovery_status(manager, project_id):
    if not isinstance(project_id,str) or not re.fullmatch(r'user-[0-9a-f]{32}',project_id):
        raise ValueError('工程身份无效。')
    target=manager.resolve(project_id)
    project=getattr(target,'project',None)
    if not isinstance(project,dict) or project.get('id')!=project_id:
        raise ValueError('工程归属无法确认。')
    result={'ok':True,'projectId':project_id}
    def state(name,message,reason,**values):return {**result,'state':name,'reasonCode':reason,'message':message,**values}
    if project.get('defaultMode') not in ('fuxa-local','fuxa-oip'):
        return state('unavailable','本工程未配置受管 FUXA 画面。','not_supported')
    try:
        from workbench_fuxa_oip import HOME, local_paths
        home=HOME.resolve();paths=local_paths(project); profile=paths['fuxa']
        for item in (paths['home'],profile,profile/'plcdev'):
            if not item.resolve().is_relative_to(home):raise ValueError('profile ownership')
        def verify_owner():
            owner=_read(paths['home']/'owner.json',32768)
            profile_owner=_read(profile/'plcdev'/'project-owner.json',32768)
            if (not isinstance(owner,dict) or owner.get('version')!=1 or owner.get('projectId')!=project_id
                    or not isinstance(owner.get('manifestPath'),str)
                    or Path(owner['manifestPath']).resolve()!=Path(project['manifestPath']).resolve()
                    or not isinstance(profile_owner,dict) or profile_owner.get('projectId')!=project_id
                    or not isinstance(profile_owner.get('file'),str)
                    or Path(profile_owner['file']).resolve()!=Path(project['hmi']).resolve()):
                raise ValueError('profile owner')
            return profile_owner
        native_dir=profile/'plcdev'/'native-write-intents'
        if native_dir.is_symlink():raise ValueError('native intent link')
        try:
            with os.scandir(native_dir) as entries:
                native_entries=[]
                for entry in entries:
                    if len(native_entries)>=32:raise ValueError('too many native intents')
                    native_entries.append(entry)
        except FileNotFoundError:native_entries=[]
        if native_entries:
            native_owner=verify_owner()
            for entry in native_entries:
                name=entry.name
                if (not name.endswith('.json') or not _UUID.fullmatch(name[:-5])
                        or not entry.is_file(follow_symlinks=False) or entry.is_symlink()):
                    raise ValueError('native intent file')
                marker=_read(Path(entry.path),4096)
                if (not isinstance(marker,dict) or set(marker)!={'version','id','projectId','configHash','endpoint','beforeDigest'}
                        or type(marker.get('version')) is not int or marker['version']!=1 or marker.get('id')!=name[:-5]
                        or marker.get('projectId')!=project_id or not isinstance(marker.get('configHash'),str)
                        or not marker['configHash'] or marker['configHash']!=native_owner.get('configHash')
                        or marker.get('endpoint') not in ('/project','/projectData','/device')
                        or not _HASH.fullmatch(str(marker.get('beforeDigest','')))):
                    raise ValueError('native intent identity')
            return state('conflict','原生画面或设备设置保存结果尚未确认；请保留原 profile、源画面及设备设置核对，未自动重试或覆盖。','native_write_unknown')
        txn=profile/'plcdev'/'transaction.json'
        if txn.is_symlink():raise ValueError('transaction link')
        try:value=_read(txn,16*1024*1024)
        except FileNotFoundError:return state('none','未发现本工程的旧 FUXA 待处理预览。','none')
        if value is None:return state('none','未发现本工程的旧 FUXA 待处理预览。','none')
        if (not isinstance(value,dict) or not _UUID.fullmatch(str(value.get('id','')))
                or any(not isinstance(value.get(key),dict) for key in ('baseline','project','spec'))):
            raise ValueError('malformed transaction')
        profile_owner=verify_owner()
        if value.get('projectId')!=project_id:
            return state('conflict','旧预览所属工程配置已改变，不能自动恢复或写回；请保留原记录。','config_changed')
        # Once the matching project's durable write intent exists, unknown
        # outcome takes precedence over later configuration or source edits.
        if 'resolution' in value:
            resolution=value['resolution']
            action=(resolution.get('action') if isinstance(resolution,dict) and type(resolution.get('version')) is int
                    and resolution['version']==1 and resolution.get('state')=='unknown' else None)
            if action=='keep':return state('conflict','上次写回的结果未知；请核对源画面及原事务记录，未自动重试或撤销。','write_outcome_unknown')
            if action=='undo':return state('conflict','上次撤销的结果未知；请核对原生画面及原事务记录，未自动重试或写回。','undo_outcome_unknown')
            return state('conflict','上次事务操作的结果未知；请保留现场核对，未自动重试、撤销或写回。','transaction_outcome_unknown')
        config=getattr(target,'config_hash',None)
        if (not isinstance(config,str) or not target.current_configuration()
                or value.get('projectId')!=project_id or value.get('configHash')!=config
                or profile_owner.get('configHash')!=config):
            return state('conflict','旧预览所属工程配置已改变，不能自动恢复或写回；请保留原记录。','config_changed')
        revision=value.get('sourceRevision')
        if revision is not None:
            if (not isinstance(revision,dict) or not _HASH.fullmatch(str(revision.get('sourceHash','')))
                    or not _HASH.fullmatch(str(revision.get('nativeBaselineHash','')))):
                raise ValueError('invalid checkpoint')
            with Path(project['hmi']).open('rb') as stream: current=hashlib.file_digest(stream,'sha256').hexdigest()
            if current!=revision['sourceHash']:
                return state('conflict','工程画面在预览后已变化；不能自动恢复或写回，请保留原记录。','source_changed')
        note=('旧 FUXA 预览待处理；打开原生编辑器核对。写回会修改当前工程画面，不创建副本。'
              if revision is not None else
              '旧 FUXA 预览没有源版本检查点；打开原生编辑器后需先核对基线。写回修改当前工程画面，不创建副本。')
        return state('pending',note,'pending' if revision is not None else 'source_checkpoint_missing',transactionId=value['id'])
    except (OSError,UnicodeError,ValueError,TypeError,KeyError):
        return state('unavailable','旧 FUXA 事务或工程归属无法核对；未更改原记录。','transaction_unreadable')
