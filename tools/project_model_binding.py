"""Project-owned model declarations and a receiver-side, session-bound frame guard.

No socket, process, PLC write or HMI permission is created by this module.
"""
from copy import deepcopy
import hashlib
import json
import math
import re
from project_interface import SIZES, bind_interface, fields, identifier, text, validate_interface, validate_value

PROTOCOL = 'project-model-v1'
DIRECTIONS = {'model-to-plc', 'plc-to-model'}


def validate_model_binding(definition, interface=None):
    fields(definition, {'schemaVersion','protocol','model','signals'},
           {'schemaVersion','protocol','model','signals'}, '模型绑定')
    if type(definition['schemaVersion']) is not int or definition['schemaVersion'] != 1 or definition['protocol'] != PROTOCOL:
        raise ValueError('仅支持 project-model-v1 版本 1')
    model = definition['model']
    fields(model, {'id','periodMs','commandTimeoutMs','feedbackTimeoutMs'},
           {'id','periodMs','commandTimeoutMs','feedbackTimeoutMs'}, '模型时基')
    identifier(model['id'])
    for key in ('periodMs','commandTimeoutMs','feedbackTimeoutMs'):
        if type(model[key]) is not int or not 1 <= model[key] <= 10000:
            raise ValueError('模型周期和失效阈值须为 1–10000 ms 整数')
    if model['periodMs'] > min(model['commandTimeoutMs'], model['feedbackTimeoutMs']):
        raise ValueError('模型周期不能大于失效阈值')
    signals = definition['signals']
    if not isinstance(signals, list) or not 1 <= len(signals) <= 128:
        raise ValueError('模型需要 1–128 个标量信号')
    public = {v['path'].upper():v for v in validate_interface(interface)['variables']} if interface else {}
    ids, paths = set(), set()
    for signal in signals:
        fields(signal, {'id','path','type','direction','unit','initial','min','max'},
               {'id','path','type','direction','unit','initial'}, '模型信号')
        ident = identifier(signal['id']); path = signal['path']
        if ident.lower() in ids:
            raise ValueError('模型信号标识重复')
        ids.add(ident.lower())
        if not isinstance(path,str) or len(path)>200 or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+',path):
            raise ValueError('模型信号需要完整 PLC 实例路径')
        if path.upper() in paths: raise ValueError('模型信号 PLC 路径重复')
        paths.add(path.upper())
        if not isinstance(signal['type'],str) or signal['type'] not in SIZES or not isinstance(signal['direction'],str) or signal['direction'] not in DIRECTIONS:
            raise ValueError('模型信号类型或方向无效')
        text(signal['unit'], '模型信号单位',24,empty=True)
        if signal['type']=='BOOL':
            if 'min' in signal or 'max' in signal: raise ValueError('BOOL 模型信号不接受数值范围')
        else:
            if 'min' not in signal or 'max' not in signal:
                raise ValueError('数值模型信号须声明 min/max')
            validate_value({'id':ident,'type':signal['type']},signal['min'])
            validate_value({'id':ident,'type':signal['type']},signal['max'])
            if signal['min']>signal['max']: raise ValueError('模型信号范围倒置')
        validate_value(signal, signal['initial'])
        variable = public.get(path.upper())
        if variable and (variable['type'] != signal['type'] or variable['access'] != 'read'):
            raise ValueError('模型反馈／执行器通道不能由普通 HMI 或 AI 操作写入：'+path)
    if not any(s['direction']=='model-to-plc' for s in signals):
        raise ValueError('模型绑定至少需要一个实际反馈信号')
    return deepcopy(definition)


def model_binding_hash(definition):
    return hashlib.sha256(json.dumps(validate_model_binding(definition),sort_keys=True,ensure_ascii=False,
                                    separators=(',',':'),allow_nan=False).encode()).hexdigest()


def bind_model(definition, leaves, interface=None):
    """Resolve every model signal to exact compiler path/type/size; never infer it."""
    definition = validate_model_binding(definition, interface)
    contract = {'schemaVersion':1,'protocol':'project-interface-v1','operations':[], 'variables':[
        {'id':s['id'],'label':s['id'],'path':s['path'],'type':s['type'],'access':'read','aiVisible':False}
        for s in definition['signals']]}
    return bind_interface(contract, leaves)


class ModelFrameGuard:
    """Only feedback values cross this lane, pinned to one Runtime and model epoch.

    now is receiver monotonic seconds. modelTimeMs is compared only with earlier
    values from the SAME epoch, never subtracted from the receiver clock. This
    guard detects freshness; the PLC and model must implement their own stops.
    """
    def __init__(self, definition, *, project_id, session_id, program_hash, epoch):
        self.definition = validate_model_binding(definition)
        for value in (project_id,session_id,program_hash,epoch):
            if not isinstance(value,str) or not value or len(value)>200: raise ValueError('模型通道身份无效')
        self.identity = {'projectId':project_id,'sessionId':session_id,'programHash':program_hash,
                         'bindingHash':model_binding_hash(definition),'epoch':epoch}
        self.signals = {s['id']:s for s in definition['signals'] if s['direction']=='model-to-plc'}
        self.sequence = 0; self.model_time_ms = None; self.last_received = None

    def accept(self, frame, *, now):
        fields(frame, {*self.identity,'sequence','modelTimeMs','values'},
               {*self.identity,'sequence','modelTimeMs','values'}, '模型反馈帧')
        if any(frame[k]!=v for k,v in self.identity.items()): raise ValueError('模型反馈工程／会话／版本／epoch 不匹配')
        seq, model_time = frame['sequence'], frame['modelTimeMs']
        if type(seq) is not int or not self.sequence < seq <= 2**53-1: raise ValueError('重复或过期模型反馈序号')
        if type(model_time) not in (int,float) or not math.isfinite(model_time) or model_time < 0:
            raise ValueError('模型时间无效')
        if self.model_time_ms is not None and model_time <= self.model_time_ms:
            raise ValueError('模型仿真时间未推进')
        if type(now) not in (int,float) or not math.isfinite(now) or now < 0 or (self.last_received is not None and now<self.last_received):
            raise ValueError('接收端单调时间无效')
        values = frame['values']
        if not isinstance(values,dict) or set(values)!=set(self.signals): raise ValueError('模型反馈值缺失或越过写入白名单')
        for ident, signal in self.signals.items(): validate_value(signal,values[ident])
        # Do not advance freshness or consume a sequence after any invalid value.
        self.sequence=seq;self.model_time_ms=model_time;self.last_received=now
        return deepcopy(values)

    def fresh(self, now):
        return (type(now) in (int,float) and math.isfinite(now) and self.last_received is not None
                and 0 <= now-self.last_received < self.definition['model']['feedbackTimeoutMs']/1000)
