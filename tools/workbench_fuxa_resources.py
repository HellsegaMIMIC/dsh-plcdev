"""Check FUXA resource portability without reading profiles or fetching URLs.

The existing project validators own executable/SVG policy. This additional
publication check mirrors their href/url() resource discovery and also covers
native view backgrounds and image properties. It does not relax their policy.
"""
import ipaddress
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from workbench_project_config import plain, read_json


RESOURCE_KEYS={'href','src','url','poster','image','imageurl','imagepath','backgroundimage',
               'bkimage','bkimg','picture','pictureurl'}
CSS_URL=re.compile(r'url\s*\(\s*([\s\S]*?)\s*\)',re.I)
CSS_KEYS={'style','styles','css','background','fill','stroke','mask','clippath'}


def _references(value, field='hmi'):
    if isinstance(value,list):
        for index,item in enumerate(value):yield from _references(item,field+'/'+str(index))
    elif isinstance(value,dict):
        for key,item in value.items():
            location=field+'/'+str(key);normalized=str(key).lower().replace('_','').replace('-','')
            if isinstance(item,str):
                if normalized in ('svgcontent','htmlcontent'):
                    if '<!DOCTYPE' in item.upper() or '<!ENTITY' in item.upper():
                        raise ValueError('画面包含无法核对的外部实体，未保存新版本。')
                    try:tree=ElementTree.fromstring(item)
                    except ElementTree.ParseError:
                        raise ValueError('画面资源引用无法解析，未保存新版本。') from None
                    for node in tree.iter():
                        for attribute,reference in node.attrib.items():
                            if attribute.rsplit('}',1)[-1].lower() in ('href','src','poster','data'):
                                yield location,reference
                            for match in CSS_URL.finditer(reference):yield location,match.group(1).strip().strip('"\'')
                        if node.tag.rsplit('}',1)[-1].lower()=='style' and node.text:
                            for match in CSS_URL.finditer(node.text):yield location,match.group(1).strip().strip('"\'')
                else:
                    css=list(CSS_URL.finditer(item)) if normalized in RESOURCE_KEYS|CSS_KEYS else []
                    if normalized in RESOURCE_KEYS and item.strip() and not css:yield location,item
                    for match in css:yield location,match.group(1).strip().strip('"\'')
            yield from _references(item,location)


def _portable(reference, hmi, root, managed):
    reference=reference.strip()
    if not reference or reference.lower()=='none' or reference.startswith('#') or reference.lower().startswith('data:'):return True
    try:parsed=urlsplit(reference)
    except ValueError:return False
    if parsed.scheme.lower() in ('http','https') or reference.startswith('//'):
        host=(parsed.hostname or '').lower().rstrip('.')
        if not host or host=='localhost' or host.endswith('.localhost'):return False
        try:
            if ipaddress.ip_address(host).is_loopback:return False
        except ValueError:pass
        return True  # Preserve the remote URL verbatim; no request or download.
    if parsed.scheme or reference.startswith(('/','\\')):return False
    path=hmi.parent/unquote(parsed.path).replace('\\','/')
    try:
        plain(path,root)
        return path.resolve() in managed
    except (OSError,ValueError):return False


def require_snapshot_resources(project, snapshot):
    """Reject only dependencies that are not portable with this managed tree."""
    if not project.get('hmi'):return
    root=Path(project['projectRoot']);hmi=Path(project['hmi']);plain(hmi,root)
    managed={(root/name).resolve() for name in snapshot['files']}
    raw=read_json(hmi)
    for _,reference in _references(raw.get('hmi',{})):
        if not _portable(reference,hmi,root,managed):
            # Never echo a native URL: it can contain private device addresses.
            raise ValueError('画面引用了未随工程保存的本地图片或资源，暂不能保存新版本。请先内嵌图片或将资源纳入工程；原工程未改变。')
