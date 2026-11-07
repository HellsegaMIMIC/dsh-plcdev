"""Authorized FUXA batch-HMI generation through the existing OpenPLC DeepSeek profile.

The destination and payload shape are fixed. Credentials stay in process memory;
stdout contains only the model response or a sanitized status. No redirects/retries.
"""
from pathlib import Path
import argparse, base64, binascii, ctypes, http.client, json, os, ssl, sys, shutil, subprocess

ROOT=Path(__file__).resolve().parents[1]
APPROVED_PROFILE=ROOT/'outputs/openplc-editor-zh/OpenPLC-Editor-ZH-deepseek-dev-20261022/profile'
BASE='https://api.deepseek.com/v1'


def unprotect(raw):
    class Blob(ctypes.Structure):
        _fields_=[('size',ctypes.c_ulong),('data',ctypes.POINTER(ctypes.c_ubyte))]
    buf=ctypes.create_string_buffer(raw)
    source=Blob(len(raw),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte))); dest=Blob()
    crypt=ctypes.WinDLL('crypt32',use_last_error=True)
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    crypt.CryptUnprotectData.argtypes=[ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(Blob)]
    kernel.LocalFree.argtypes=[ctypes.c_void_p]
    if not crypt.CryptUnprotectData(ctypes.byref(source),None,None,None,None,1,ctypes.byref(dest)):
        raise ValueError('credential-unavailable')
    try:return ctypes.string_at(dest.data,dest.size)
    finally:kernel.LocalFree(dest.data)


def configuration(profile):
    if os.name!='nt' or profile.resolve()!=APPROVED_PROFILE.resolve():raise ValueError('unapproved-profile')
    public=json.loads((profile/'plcdev-ai-provider.json').read_text(encoding='utf-8-sig'))
    if public.get('provider')!='deepseek' or public.get('baseUrl')!=BASE:raise ValueError('unapproved-destination')
    if public.get('model')!='deepseek-flash':raise ValueError('unapproved-model')
    encrypted=base64.b64decode(public['encryptedApiKey'],validate=True)
    if encrypted[:3]!=b'v10':raise ValueError('unsupported-credential-format')
    local=json.loads((profile/'Local State').read_text(encoding='utf-8-sig'))
    master=base64.b64decode(local['os_crypt']['encrypted_key'],validate=True)
    if not master.startswith(b'DPAPI'):raise ValueError('unsupported-key-format')
    sys.path.insert(0,str(ROOT/'.tools/fuxa-ai-python'))
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    clear=AESGCM(unprotect(master[5:])).decrypt(encrypted[3:15],encrypted[15:],None)
    secret=json.loads(clear.decode('utf-8'))
    if secret.get('baseUrl')!=BASE or secret.get('model')!=public['model']:raise ValueError('credential-destination-mismatch')
    key=secret.get('apiKey')
    if not isinstance(key,str) or not 8<len(key)<4096 or any(c.isspace() for c in key):raise ValueError('credential-unavailable')
    return public['model'],key


def approved_system():
    interface=os.environ.get('PLCDEV_FUXA_INTERFACE_FILE')
    if not interface:
        return (ROOT/'software/fuxa-integration/model-system.txt').read_text(encoding='utf-8')+'\nJSON Schema:\n'+(ROOT/'software/fuxa-integration/model-schema.json').read_text(encoding='utf-8')
    source=Path(interface)
    if not source.is_absolute() or not source.is_file() or source.stat().st_size>524288:
        raise ValueError('invalid-project-interface')
    node=shutil.which('node')
    bundled=ROOT/'outputs/openplc-editor-zh/node-v22.22.0-win-x64/node.exe'
    if bundled.is_file():node=str(bundled)
    if not node:raise ValueError('interface-validator-unavailable')
    result=subprocess.run([node,str(ROOT/'software/fuxa-integration/project-interface.cjs'),'system','--contract',str(source)],capture_output=True,timeout=15,check=False,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    if result.returncode or len(result.stdout)>524288:raise ValueError('invalid-project-interface')
    return result.stdout.decode('utf-8')


def validated_request(value):
    if not isinstance(value,dict) or set(value)!={'messages','response_format'}:raise ValueError('invalid-request')
    messages=value['messages']
    expected=approved_system()
    if not isinstance(messages,list) or len(messages)!=2:raise ValueError('invalid-messages')
    if messages[0]!={'role':'system','content':expected}:raise ValueError('unapproved-system-prompt')
    user=messages[1]
    if not isinstance(user,dict) or set(user)!={'role','content'} or user['role']!='user':raise ValueError('invalid-hmi-request')
    content=user['content']
    if not isinstance(content,str) or not 8<=len(content)<=32000 or '现有画面上下文' not in content:raise ValueError('invalid-hmi-context')
    if value['response_format']!={'type':'json_object'}:raise ValueError('invalid-output-format')
    return value


def check_configuration(profile):
    """Local-only readiness check; never return configuration or exception text."""
    try:
        model,_key=configuration(profile)
        return {'ok':True,'hasKey':True,'model':model,'providerHost':'api.deepseek.com','state':'ready'}
    except FileNotFoundError:
        state,code='missing','configuration-missing'
    except ImportError:
        state,code='unavailable','check-dependency-unavailable'
    except (OSError,UnicodeError,json.JSONDecodeError,KeyError,TypeError,binascii.Error):
        state,code='unreadable','configuration-unreadable'
    except Exception as exc:
        # Only our fixed validation codes are eligible for output.
        known={'unapproved-profile','unapproved-destination','unapproved-model','credential-destination-mismatch','unsupported-credential-format','unsupported-key-format'}
        state='unreadable';code=str(exc) if isinstance(exc,ValueError) and str(exc) in known else 'credential-unavailable'
    return {'ok':False,'hasKey':False,'state':state,'error':code}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',type=Path,default=APPROVED_PROFILE)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if args.check:
        status=check_configuration(args.profile)
        print(json.dumps(status));return 0 if status['ok'] else 1
    try:
        request=validated_request(json.loads(sys.stdin.buffer.read(524289)))
        model,key=configuration(args.profile)
        body=json.dumps({'model':model,**request,'stream':False,'thinking':{'type':'disabled'},'max_tokens':8192},ensure_ascii=False).encode('utf-8')
        conn=http.client.HTTPSConnection('api.deepseek.com',443,timeout=150,context=ssl.create_default_context())
        try:
            conn.request('POST','/v1/chat/completions',body,{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
            response=conn.getresponse()
            if response.status!=200:
                print(json.dumps({'ok':False,'error':'provider-http-error','status':response.status}));return 1
            raw=response.read(1048577)
            if len(raw)>1048576:raise ValueError('model-output-too-large')
            data=json.loads(raw);content=data['choices'][0]['message']['content']
            if not isinstance(content,str):raise ValueError('invalid-model-content')
            json.loads(content)
            print(json.dumps({'ok':True,'model':data.get('model',model),'providerHost':'api.deepseek.com','content':content,'usage':data.get('usage')},ensure_ascii=True));return 0
        finally:conn.close()
    except Exception as exc:
        # Never serialize exception messages, request headers, profile or response bodies.
        code=str(exc) if isinstance(exc,ValueError) and str(exc) in {'invalid-request','invalid-messages','unapproved-system-prompt','invalid-hmi-request','invalid-hmi-context','invalid-output-format','unapproved-profile','unapproved-destination','unapproved-model','credential-destination-mismatch','credential-unavailable','unsupported-credential-format','unsupported-key-format','model-output-too-large','invalid-model-content'} else 'hmi-generation-failed'
        print(json.dumps({'ok':False,'error':code}));return 1

if __name__=='__main__':raise SystemExit(main())
