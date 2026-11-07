import React, { useEffect, useRef, useState } from 'react';
import './PLCdevDSH.css';
type IconName = 'chip' | 'chat' | 'plus' | 'search' | 'grid' | 'folder' | 'chevron' | 'arrow' | 'check' | 'branch' | 'monitor' | 'box' | 'code' | 'close' | 'clock' | 'file' | 'undo' | 'play' | 'pause' | 'settings' | 'dots' | 'expand' | 'link' | 'alert' | 'refresh' | 'layers';
const paths: Record<IconName, string> = {
  chip: 'M7 7h10v10H7zM10 10h4v4h-4zM9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4',
  chat: 'M4 4h16v12H9l-5 4zM8 8h8m-8 4h5',
  plus: 'M12 5v14M5 12h14',
  search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  folder: 'M3 6h7l2 3h9v11H3zM3 6V4h7l2 2h8v3',
  chevron: 'M9 5l7 7-7 7',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  check: 'M5 12l4 4L19 6',
  branch: 'M6 3v12a4 4 0 0 0 4 4h8M6 7h7a5 5 0 0 0 5-5M3 3h6M15 19h6',
  monitor: 'M3 4h18v13H3zM12 17v4m-5 0h10M7 8h4m-4 4h8',
  box: 'M12 3l9 5v9l-9 5-9-5V8zM3 8l9 5 9-5m-9 5v9M7 5l9 5',
  code: 'M8 6l-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  close: 'M6 6l12 12M6 18 18 6',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  file: 'M5 3h9l5 5v13H5zM14 3v6h5M9 13h6m-6 4h6',
  undo: 'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',
  play: 'M7 4l13 8-13 8z',
  pause: 'M8 5v14m8-14v14',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  dots: 'M4 12h.01M12 12h.01M20 12h.01',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  link: 'M10 7l2-2a5 5 0 0 1 7 7l-2 2M14 17l-2 2a5 5 0 0 1-7-7l2-2m1 6 8-8',
  alert: 'M12 3 2 21h20zM12 9v5m0 3v1',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14-1l1 6M4 12l1 6a8 8 0 0 0 14-1',
  layers: 'M12 3 2 8l10 5 10-5zM3 12l9 5 9-5M3 16l9 5 9-5'
};
function Icon({
  name,
  size = 18,
  className = ''
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function Conveyor({
  moving = false
}: {
  moving?: boolean;
}) {
  return <svg className={'pd-conveyor ' + (moving ? 'is-moving' : '')} viewBox="0 0 460 164" role="img" aria-label="输送带候选画面示意，光电传感器与两个纸箱">
    <defs><pattern id="pd-floor" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0V22" fill="none" stroke="#dbe2df" strokeWidth=".6" /></pattern><linearGradient id="pd-belt" x2="0" y2="1"><stop stopColor="#54686c" /><stop offset="1" stopColor="#2d4248" /></linearGradient></defs>
    <rect width="460" height="164" fill="url(#pd-floor)" />
    <ellipse cx="232" cy="139" rx="184" ry="9" fill="#cfd9d5" opacity=".55" />
    <path d="M66 100v34h15v-33m281-1v34h15v-34" fill="#a3b5b2" stroke="#7a9290" />
    <path d="M57 79h335v30H57z" fill="#c1d0cc" /><rect x="40" y="86" width="372" height="29" rx="14.5" fill="url(#pd-belt)" stroke="#2b4246" strokeWidth="2" />
    {Array.from({
      length: 17
    }, (_, i) => <circle key={i} cx={55 + i * 21.1} cy="100" r="7" fill="#93a6a7" stroke="#263b40" strokeWidth="2" />)}
    <path d="M54 86h344" stroke="#1e716d" strokeWidth="4" />
    <g className="pd-parcels"><g transform="translate(102 36)"><path d="M0 13 23 0l43 11-23 14z" fill="#e2b582" /><path d="M0 13v36l43 9V25z" fill="#c79563" /><path d="M43 25v33l23-13V11z" fill="#af7e50" /><path d="m18 3 42 12-12 7L6 10" fill="#f0d6ae" /><path d="M19 35v12m6-11v12" stroke="#8c633f" strokeWidth="2" /></g><g transform="translate(272 47)"><path d="M0 10 19 0l35 9-19 11z" fill="#ebc294" /><path d="M0 10v31l35 8V20z" fill="#cea171" /><path d="M35 20v29l19-11V9z" fill="#b78a5d" /><path d="m14 3 35 9-9 5L5 8" fill="#f3dbb6" /></g></g>
    <path d="M236 38v48" stroke="#70b5a4" strokeWidth="1.5" strokeDasharray="4 4" /><rect x="227" y="28" width="18" height="13" rx="3" fill="#40595b" /><circle cx="236" cy="35" r="3" fill="#73c3a7" />
    <path d="M329 143h54m-5-4 5 4-5 4" stroke="#7d9490" strokeWidth="1.5" fill="none" />
    <text x="252" y="33" fill="#6a807c" fontSize="10" fontFamily="inherit">光电检测</text><text x="48" y="148" fill="#7f918c" fontSize="10" fontFamily="monospace">CONVEYOR / 01</text>
  </svg>;
}
type NativeTab = 'hmi' | 'plc' | 'binding' | 'topology';
type Candidate = {
  id: string;
  project: 'a' | 'b';
  version: number;
  target: number;
  delay: number;
  prompt: string;
  phase: 'generating' | 'paused' | 'review' | 'kept';
  step: number;
  feedback: string;
};
type NativeSession = {
  binding: 'a' | 'b' | null;
  tasks: Candidate[];
};
const nativeProjects = {
  a: {
    name: '输送带 A 线',
    file: 'conveyor-a.plcdev',
    version: 'v12'
  },
  b: {
    name: '输送带 B 线',
    file: 'conveyor-b.plcdev',
    version: 'v4'
  }
};
const nativePrompt = '给输送带增加 3 秒启动延时，计满 5 件停止。同步修改 PLC、HMI 和场景，先给我候选。';
const nativeKey = 'plcdev-dsh-native-integration-v2';
function nativeDefaults(): Record<'main' | 'second', NativeSession> {
  return {
    main: {
      binding: 'a',
      tasks: [{
        id: 'T-014',
        project: 'a',
        version: 2,
        target: 5,
        delay: 3,
        prompt: nativePrompt,
        phase: 'review',
        step: 4,
        feedback: ''
      }]
    },
    second: {
      binding: null,
      tasks: []
    }
  };
}
function readNative() {
  try {
    const s = JSON.parse(localStorage.getItem(nativeKey) || 'null');
    if (s?.schema === 2 && s.sessions?.main && s.sessions?.second) {
      const result = nativeDefaults();
      for (const id of ['main', 'second'] as const) {
        const value = s.sessions[id];
        result[id] = {
          binding: ['a', 'b'].includes(value.binding) ? value.binding : null,
          tasks: Array.isArray(value.tasks) ? value.tasks.filter((t: Candidate) => ['a', 'b'].includes(t.project) && ['generating', 'paused', 'review', 'kept'].includes(t.phase)).map((t: Candidate) => ({
            ...t,
            target: Math.min(1000, Math.max(1, Number(t.target) || 5)),
            delay: Math.min(60, Math.max(0, Number(t.delay) || 0)),
            phase: t.phase === 'generating' ? 'paused' : t.phase
          })).slice(-8) : []
        };
      }
      return result;
    }
  } catch {}
  return nativeDefaults();
}
type ToolchainId = 'openplc' | 'fuxa' | 'oip' | 'runtime';
type ToolchainProject = 'a' | 'b';
type ToolchainState = Record<ToolchainProject, {
  fuxa: 'stopped' | 'ready' | 'error';
  oip: boolean;
}>;
function ToolchainReadiness({
  project,
  state,
  onChange
}: {
  project: ToolchainProject | null;
  state: ToolchainState;
  onChange: (project: ToolchainProject, patch: Partial<ToolchainState['a']>) => void;
}) {
  const [detail, setDetail] = useState<ToolchainId | null>(null);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState(false);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const value = project ? state[project] : null;
  const projectName = project ? nativeProjects[project].name : '尚未关联工程';
  const cards: {
    id: ToolchainId;
    name: string;
    role: string;
    icon: IconName;
    status: string;
    tone: string;
    rows: [string, string, boolean][];
    hint: string;
  }[] = [{
    id: 'openplc',
    name: 'OpenPLC',
    role: 'PLC 编程与编译',
    icon: 'code',
    status: project ? '已就绪' : '待关联',
    tone: project ? 'ready' : 'idle',
    rows: [['安装与版本', '已识别', true], ['编辑器 / 编译器', '可用', true], ['当前工程', project ? '已关联' : '未关联', !!project]],
    hint: project ? '可打开工程、生成与编译候选。' : '关联工程后检查程序与编译配置。'
  }, {
    id: 'fuxa',
    name: 'FUXA',
    role: 'HMI 画面与监控',
    icon: 'monitor',
    status: !project ? '待关联' : value?.fuxa === 'ready' ? '已就绪' : value?.fuxa === 'error' ? '连接异常' : '待启动',
    tone: !project ? 'idle' : value?.fuxa === 'ready' ? 'ready' : value?.fuxa === 'error' ? 'error' : 'waiting',
    rows: [['安装与版本', '已识别', true], ['画面服务', !project ? '待检查' : value?.fuxa === 'ready' ? '可访问' : value?.fuxa === 'error' ? '无响应' : '未启动', value?.fuxa === 'ready'], ['当前画面', project ? '已关联' : '未关联', !!project]],
    hint: !project ? '选择工程后检查独立画面服务。' : value?.fuxa === 'ready' ? '画面服务可用，PLC 通信仍待建立。' : value?.fuxa === 'error' ? '画面服务无响应，需要检查连接。' : '启动本工程的画面服务后可编辑。'
  }, {
    id: 'oip',
    name: 'OIP',
    role: '场景与过程仿真',
    icon: 'box',
    status: !project ? '待关联' : value?.oip ? '已就绪' : '待关联',
    tone: value?.oip ? 'ready' : project ? 'waiting' : 'idle',
    rows: [['安装与版本', '已识别', true], ['场景编辑器', '可启动', true], ['工程场景', value?.oip ? '已关联' : '未关联', !!value?.oip]],
    hint: !project ? '先选择工程，再关联仿真场景。' : value?.oip ? '场景已关联，尚未开始联动运行。' : '为当前工程选择一个仿真场景。'
  }];
  const active = cards.find(card => card.id === detail);
  function recheck() {
    if (checking || pending) return;
    setChecking(true);
    setNotice('');
    timer.current = setTimeout(() => {
      setChecking(false);
      setChecked(true);
      setNotice('演示检查完成，已更新当前状态。');
    }, 650);
  }
  function startFuxa() {
    if (!project || pending || checking) return;
    const boundProject = project;
    setPending(true);
    setNotice('');
    timer.current = setTimeout(() => {
      onChange(boundProject, {
        fuxa: 'ready'
      });
      setPending(false);
      setNotice('FUXA 画面服务已就绪（演示），PLC Runtime 状态保持未连接。');
    }, 700);
  }
  const details = detail === 'runtime' ? [['运行服务', '未核验'], ['PLC 程序', '未装载'], ['运行工程', '无已确认会话'], ['编译结果', '尚未验证']] : detail === 'openplc' ? [['编辑器安装', '已识别 · 演示'], ['IEC 编译器', '依赖可用 · 演示'], ['工程上下文', projectName], ['当前候选', '待实际编译']] : detail === 'fuxa' ? [['服务状态', !project ? '待检查' : value?.fuxa === 'ready' ? '可访问（演示）' : value?.fuxa === 'error' ? '连接失败（演示）' : '未启动'], ['服务归属', projectName], ['画面资源', project ? '已关联工程画面' : '未关联'], ['PLC 通信', '未建立']] : [['场景编辑器', '可启动（演示）'], ['工程上下文', projectName], ['场景资源', value?.oip ? '输送带示例场景（演示）' : '未关联'], ['运行联动', '未启动']];
  return <section className="ni-toolchain" aria-label="工具链就绪情况" aria-busy={checking}>
    <div className="ni-toolchain-heading"><div><div className="ni-toolchain-title"><h2>开发与联动</h2><span className="ni-demo-label">演示状态</span></div><p>PLC 编写可以先开始，画面与仿真按需准备。</p></div><div><span className="ni-check-time">{checking ? '正在检查…' : checked ? '刚刚检查 · 演示' : '尚未连接实际检测'}</span><button className="ni-btn" onClick={recheck} disabled={checking || pending}><Icon name="refresh" size={14} className={checking ? 'ni-spin' : ''} />{checking ? '检查中…' : '重新检查'}</button></div></div>
    <div className="ni-toolchain-grid">{cards.map(card => <article className={'ni-tool-card ' + card.tone} data-tool={card.id} key={card.id}><div className="ni-tool-card-header"><span className={'ni-tool-logo ' + card.id}><Icon name={card.icon} size={21} /></span><div><h3>{card.name}<span className="ni-tool-purpose">{card.id === 'openplc' ? '基础' : '按需'}</span></h3><p>{card.role}</p></div><span className={'ni-tool-badge ' + (checking ? 'idle' : card.tone)}><i />{checking ? '检查中' : pending && card.id === 'fuxa' ? '启动中' : card.status}</span></div><dl>{card.rows.map(([label, status, ok]) => <div key={label}><dt>{label}</dt><dd className={ok ? 'ok' : 'attention'}>{checking ? '检查中…' : <><Icon name={ok ? 'check' : 'clock'} size={12} />{status}</>}</dd></div>)}</dl><p className="ni-tool-hint">{card.hint}</p><footer><button aria-expanded={detail === card.id} aria-label={'查看 ' + card.name + ' 就绪详情'} onClick={() => {
            setDetail(detail === card.id ? null : card.id);
            setNotice('');
          }}>检查详情<Icon name="chevron" size={12} /></button>{card.id === 'fuxa' && value?.fuxa !== 'ready' ? <button className="ni-tool-action" disabled={!project || checking || pending} onClick={startFuxa}>{pending ? '启动中…' : value?.fuxa === 'error' ? '重试连接（演示）' : '启动服务（演示）'}</button> : card.id === 'oip' && !value?.oip ? <button className="ni-tool-action" disabled={!project || checking} onClick={() => {
            setDetail('oip');
            setNotice('');
          }}>关联场景<Icon name="link" size={12} /></button> : <button className="ni-tool-action" disabled={!project || checking} onClick={() => setNotice(`${card.name} 入口演示：将打开${projectName}的${card.id === 'openplc' ? 'PLC 工程' : card.id === 'fuxa' ? 'HMI 画面' : '仿真场景'}。本原型不会启动外部软件。`)}>{card.id === 'openplc' ? '打开工程' : card.id === 'fuxa' ? '打开画面' : '打开场景'}<Icon name="arrow" size={12} /></button>}</footer></article>)}</div>
    <div className="ni-runtime-readiness" data-tool="runtime"><span className="ni-runtime-logo"><Icon name="chip" size={18} /></span><div><b>OpenPLC Runtime</b><span>{projectName} · 独立运行会话</span></div><span className="ni-tool-badge idle"><i />未连接</span><p>编译、装载与运行分别确认。</p><button onClick={() => {
        setDetail(detail === 'runtime' ? null : 'runtime');
        setNotice('');
      }} aria-expanded={detail === 'runtime'}>运行详情<Icon name="chevron" size={12} /></button></div>
    {detail && <div className="ni-tool-detail" role="region" aria-label={(active?.name || 'OpenPLC Runtime') + ' 检查详情'}><header><div><Icon name={active?.icon || 'chip'} size={17} /><h3>{active?.name || 'OpenPLC Runtime'} · 检查详情</h3><span>{projectName}</span></div><button className="ni-icon" aria-label="关闭工具详情" onClick={() => setDetail(null)}><Icon name="close" size={16} /></button></header><dl>{details.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl><footer>{detail === 'oip' && !value?.oip ? <><p>选择一个示例场景，演示与当前工程建立关联。</p><button className="ni-btn ni-primary" disabled={!project || checking} onClick={() => {
            if (project) {
              onChange(project, {
                oip: true
              });
              setNotice('已关联输送带示例场景（演示），尚未启动场景运行。');
            }
          }}>使用输送带示例场景（演示）<Icon name="link" size={13} /></button></> : detail === 'fuxa' ? <><p>{value?.fuxa === 'error' ? '画面服务未响应；可重试连接，Runtime 保持原状态。' : '服务就绪只表示画面可以访问。'}</p><button className="ni-btn" disabled={!project || pending || checking} onClick={() => {
            if (project) {
              onChange(project, {
                fuxa: 'error'
              });
              setNotice('已切换到连接异常的演示状态。');
            }
          }}>模拟连接异常</button></> : detail === 'runtime' ? <><p>候选尚未完成编译，当前没有已确认的运行会话。</p><button className="ni-btn" disabled>准备运行</button></> : <p>安装、编译器可用与候选编译通过，分别记录。</p>}</footer></div>}
    {notice && <p className="ni-tool-notice" role="status"><Icon name="check" size={13} />{notice}</p>}
  </section>;
}
type HxCategory = 'plc' | 'hmi' | 'scene' | 'binding' | 'candidate';
type HxNode = 'plc' | 'runtime' | 'hmi' | 'scene';
type HxInfoTab = 'properties' | 'variables' | 'diagnostics';
type HxSelection = {
  id: string; title: string; category: HxCategory | null; icon: IconName;
  path: string; description: string; nodes: HxNode[]; edge?: string;
};
type HorizontalWorkspaceProps = {
  project: ToolchainProject;
  onProjectChange: (project: ToolchainProject) => void;
  state: ToolchainState;
  onToolChange: (project: ToolchainProject, patch: Partial<ToolchainState['a']>) => void;
  candidate?: Candidate;
  onEnterConversation: () => void;
  onReviewCandidate: () => void;
  onReturnConversation: () => void;
  onNotify: (message: string) => void;
};
function HorizontalWorkspace({ project, onProjectChange, state, onToolChange, candidate, onEnterConversation, onReviewCandidate, onReturnConversation, onNotify }: HorizontalWorkspaceProps) {
  const [menu, setMenu] = useState<HxCategory | null>(null);
  const [selectedId, setSelectedId] = useState('main');
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoTab, setInfoTab] = useState<HxInfoTab>('properties');
  const [infoHeight, setInfoHeight] = useState(180);
  const [environment, setEnvironment] = useState(false);
  const [events, setEvents] = useState<string[]>(['工程视图已打开 · 演示数据，尚未连接真实服务。']);
  const menuRoot = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const resource = nativeProjects[project];
  const tools = state[project];
  const ownedCandidate = candidate?.project === project ? candidate : undefined;
  const selections: Record<string, HxSelection> = {
    main: { id: 'main', title: 'Main.ld', category: 'plc', icon: 'code', path: 'plc/Main.ld', description: '主程序 · 批次启停、计数与故障恢复。', nodes: ['plc'] },
    fb: { id: 'fb', title: 'DelayStartFB.ld', category: 'plc', icon: 'code', path: 'plc/DelayStartFB.ld', description: 'LD 功能块 · 延时启动，停止时复位。', nodes: ['plc'] },
    hmi: { id: 'hmi', title: 'BatchPanel.fuxap', category: 'hmi', icon: 'monitor', path: 'hmi/BatchPanel.fuxap', description: 'FUXA 工程画面 · 计数显示与操作请求。', nodes: ['hmi'] },
    scene: { id: 'scene', title: 'Conveyor.scene', category: 'scene', icon: 'box', path: 'simulation/oip/Conveyor.scene', description: 'OIP 输送带场景 · 箱子、传感器与执行器。', nodes: ['scene'] },
    runtime: { id: 'runtime', title: 'OpenPLC Runtime', category: null, icon: 'chip', path: '本机隔离执行目标', description: '运行会话独立于工程查看和 AI 对话。', nodes: ['runtime'] },
    compile: { id: 'compile', title: '编译与装载', category: 'plc', icon: 'arrow', path: 'OpenPLC 工程 → Runtime', description: '程序交付关系；尚未执行编译或装载。', nodes: ['plc', 'runtime'], edge: 'compile' },
    'hmi-link': { id: 'hmi-link', title: 'HMI 变量绑定', category: 'binding', icon: 'link', path: 'bindings/hmi.json', description: 'FUXA ↔ Runtime · 经本机适配层以 HTTP 读写变量，通信未建立。', nodes: ['hmi', 'runtime'], edge: 'hmi-link' },
    'io-link': { id: 'io-link', title: 'OIP I/O 映射', category: 'binding', icon: 'link', path: 'bindings/oip.json', description: 'Runtime ↔ OIP · 经适配层使用 Modbus TCP，通信未建立。', nodes: ['runtime', 'scene'], edge: 'io-link' },
    candidate: { id: 'candidate', title: ownedCandidate ? `批次控制 · 候选 v${ownedCandidate.version}` : '候选成果', category: 'candidate', icon: 'layers', path: ownedCandidate ? `${ownedCandidate.id} · 基于 ${resource.version}` : '尚未生成', description: 'PLC、HMI 与场景的联合候选；尚未应用到原工程。', nodes: [] }
  };
  const selected = selections[selectedId] || selections.main;
  const categories: { id: HxCategory; label: string; icon: IconName; items: string[] }[] = [
    { id: 'plc', label: 'PLC 程序', icon: 'code', items: ['main', 'fb'] },
    { id: 'hmi', label: 'HMI 画面', icon: 'monitor', items: ['hmi'] },
    { id: 'scene', label: '仿真场景', icon: 'box', items: tools.oip ? ['scene'] : [] },
    { id: 'binding', label: '变量绑定', icon: 'link', items: tools.oip ? ['hmi-link', 'io-link'] : ['hmi-link'] },
    { id: 'candidate', label: '候选成果', icon: 'layers', items: ownedCandidate ? ['candidate'] : [] }
  ];
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menuRoot.current && !menuRoot.current.contains(event.target as Node)) setMenu(null);
    };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(null); setEnvironment(false); } };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, []);
  useEffect(() => { setSelectedId('main'); setMenu(null); setInfoOpen(false); setInfoTab('properties'); setEnvironment(false); setEvents(['工程视图已切换 · 对话与运行会话保持各自归属。']); }, [project]);
  function select(id: string) {
    setSelectedId(id); setMenu(null); setInfoTab('properties'); setInfoOpen(true);
    setEvents(old => [...old.slice(-4), `查看 ${selections[id].title} · ${resource.name}（原型操作）`]);
    requestAnimationFrame(() => {
      const container = viewport.current;
      if (!container) return;
      const targets = selections[id].nodes.map(nodeId => container.querySelector<HTMLElement>(`[data-node="${nodeId}"]`)).filter((item): item is HTMLElement => !!item);
      if (!targets.length) return;
      const left = Math.min(...targets.map(item => item.offsetLeft));
      const right = Math.max(...targets.map(item => item.offsetLeft + item.offsetWidth));
      const top = Math.min(...targets.map(item => item.offsetTop));
      const bottom = Math.max(...targets.map(item => item.offsetTop + item.offsetHeight));
      container.scrollLeft = Math.max(0, (left + right - container.clientWidth) / 2);
      container.scrollTop = Math.max(0, (top + bottom - container.clientHeight) / 2);
    });
  }
  function openTool(node: HxNode) {
    const target = node === 'plc' ? 'OpenPLC 工程' : node === 'hmi' ? 'FUXA 画面' : node === 'scene' ? 'OIP 场景' : 'Runtime 管理';
    onNotify(`入口演示：${resource.name} · ${target}。本原型未启动外部工具或运行会话。`);
    setEvents(old => [...old.slice(-4), `查看 ${target}入口 · 仅演示，未启动程序。`]);
  }
  function switchProject(next: ToolchainProject) {
    if (next !== project) onProjectChange(next);
    setMenu(null);
  }
  function fitCanvas() {
    if (viewport.current) { viewport.current.scrollLeft = Math.max(0, (viewport.current.scrollWidth - viewport.current.clientWidth) / 2); viewport.current.scrollTop = 0; }
  }
  const nodeClass = (id: HxNode) => selected.nodes.includes(id) ? selected.edge ? ' is-related' : ' is-selected' : '';
  const node = (id: HxNode, title: string, subtitle: string, icon: IconName, x: number, y: number, resourceId: string, status: string) => <button key={id} type="button" className={'hx-node hx-' + id + nodeClass(id)} data-node={id} aria-label={'选择 ' + title} aria-pressed={selected.nodes.includes(id)} style={{ left: `${x / 10}%`, top: y, width: '20%', height: id === 'plc' ? 110 : 120 }} onClick={() => select(resourceId)}>
    <span className="hx-node-heading"><span className={'hx-node-icon ' + id}><Icon name={icon} size={21}/></span><b>{title}</b></span>
    <span className="hx-node-copy"><b>{subtitle}</b><small>{resource.name}</small></span>
    <span className={'hx-node-status ' + (id === 'plc' ? 'ready' : 'idle')}><i/>{status}</span>
    {id === 'plc' && <span className="hx-port bottom"/>}{id === 'runtime' && <><span className="hx-port top"/><span className="hx-port left"/>{tools.oip && <span className="hx-port right"/>}</>}{id === 'hmi' && <span className="hx-port right"/>}{id === 'scene' && <span className="hx-port left"/>}
  </button>;
  const propertyRows = selected.id === 'runtime' ? [['所属工程', resource.name], ['执行目标', '本机隔离 Runtime'], ['运行会话', '未创建'], ['PLC 状态', '未连接 · 尚未核验']] : selected.edge ? [['所属工程', resource.name], ['连接双方', selected.path.startsWith('bindings') ? selected.id === 'hmi-link' ? 'FUXA ↔ Runtime' : 'Runtime ↔ OIP' : selected.path], ['连接状态', selected.id === 'compile' ? '尚未编译 / 装载' : '未连接'], ['数据质量', '未知 · 未接入真实服务']] : selected.id === 'candidate' ? [['所属工程', resource.name], ['任务', ownedCandidate?.id || '无'], ['源版本', resource.version], ['候选状态', ownedCandidate ? ({generating:'生成中 · 尚未形成候选',paused:'已暂停 · 返回对话可继续',review:'待审阅 · 未应用',kept:'已保留 · 待编译'}[ownedCandidate.phase]) : '尚未生成']] : [['所属工程', resource.name], ['资源位置', selected.path], ['保存版本', resource.version], ['资源状态', selected.id === 'hmi' ? tools.fuxa === 'ready' ? '画面服务可用（演示）' : '画面服务待启动（演示）' : selected.id === 'scene' ? '已关联 · 未运行（演示）' : '已关联 · 待编译（演示）']];
  return <section className="hx-workspace" aria-label="PLCdev 工程工作区">
    <header className="hx-header"><div className="hx-project-selector"><Icon name="folder" size={21}/><div><span className="hx-eyebrow">PLCdev · 工程工作区</span><label className="ni-sr" htmlFor="hx-project">选择工程</label><select id="hx-project" aria-label="选择工程" value={project} onChange={event => switchProject(event.target.value as ToolchainProject)}>{(['a','b'] as const).map(id => <option key={id} value={id}>{nativeProjects[id].name}</option>)}</select></div><span className="hx-saved-version">{resource.version} 已保存</span></div><div className="hx-header-meta"><span className="hx-runtime-state"><i/>Runtime 未连接</span><span className="hx-demo-label">演示状态</span></div><div className="hx-header-actions"><button type="button" className="hx-return-chat" onClick={onReturnConversation}>返回当前对话</button><button type="button" className="ni-btn ni-primary" onClick={onEnterConversation}><Icon name="chat" size={15}/>进入工程对话<Icon name="arrow" size={14}/></button></div></header>
    <nav className="hx-resource-nav" aria-label="工程资源" ref={menuRoot}>{categories.map(category => <div className="hx-resource-item" key={category.id}><button type="button" className={'hx-resource-trigger' + (selected.category === category.id ? ' is-active' : '')} aria-expanded={menu === category.id} aria-controls={'hx-menu-' + category.id} onClick={() => setMenu(menu === category.id ? null : category.id)}><Icon name={category.icon} size={16}/>{category.label}<small>{category.items.length}</small><Icon name="chevron" className="ni-down" size={11}/></button>{menu === category.id && <div className="hx-resource-menu" id={'hx-menu-' + category.id} role="region" aria-label={category.label + '资源'}><header><b>{category.label}</b><small>{resource.name}</small></header>{category.items.map(id => <button type="button" className="hx-resource-entry" data-resource={id} key={id} aria-pressed={selectedId === id} onClick={() => select(id)}><Icon name={selections[id].icon} size={17}/><span><b>{selections[id].title}</b><small>{selections[id].path}</small></span>{selectedId === id && <Icon name="check" size={14}/>}</button>)}{category.id === 'scene' && !tools.oip && <div className="hx-menu-empty"><p>当前工程尚未关联场景。</p><button type="button" className="ni-btn" onClick={() => {onToolChange(project,{oip:true});select('scene');onNotify(`已为${resource.name}关联输送带场景（演示），尚未开始运行。`);}}><Icon name="plus" size={14}/>关联输送带场景（演示）</button></div>}{category.id === 'candidate' && !ownedCandidate && <div className="hx-menu-empty"><p>本工程暂无候选成果。</p><button type="button" className="ni-btn" onClick={onEnterConversation}>进入工程对话</button></div>}<footer>选择资源以定位拓扑与查看属性</footer></div>}</div>)}<button type="button" className="hx-environment-trigger" onClick={() => {setMenu(null);setEnvironment(true);}}><Icon name="settings" size={15}/>开发环境</button></nav>
    <div className="hx-canvas-toolbar"><div><Icon name="branch" size={17}/><h2>工程拓扑</h2><span>{resource.name}</span></div><div className="hx-map-legend"><span><i className="dashed"/>程序交付</span><span><i/>运行通信 · 未连接</span></div><button type="button" aria-label="居中拓扑" onClick={fitCanvas}><Icon name="expand" size={15}/>居中</button></div>
    <div className="hx-viewport" ref={viewport}><div className="hx-canvas" aria-label={resource.name + ' 实例拓扑'}>
      <svg className="hx-wires" viewBox="0 0 1000 380" width="100%" height="380" preserveAspectRatio="none" aria-hidden="true"><path className={'hx-wire delivery' + (selected.edge === 'compile' ? ' is-selected' : '')} d="M500 128V220"/><path className={'hx-wire' + (selected.edge === 'hmi-link' ? ' is-selected' : '')} d="M250 280H400"/>{tools.oip && <path className={'hx-wire' + (selected.edge === 'io-link' ? ' is-selected' : '')} d="M600 280H750"/>}</svg>
      <button type="button" className={'hx-edge-label' + (selected.edge === 'compile' ? ' is-selected' : '')} data-edge="compile" style={{left:'51.6%',top:155}} onClick={() => select('compile')}><Icon name="arrow" className="ni-down" size={14}/><span>编译装载<small>尚未编译</small></span></button>
      <button type="button" className={'hx-edge-label' + (selected.edge === 'hmi-link' ? ' is-selected' : '')} data-edge="hmi-link" style={{left:'27.2%',top:238}} onClick={() => select('hmi-link')}><Icon name="link" size={14}/><span>变量读写<small>未连接</small></span></button>
      {tools.oip && <button type="button" className={'hx-edge-label' + (selected.edge === 'io-link' ? ' is-selected' : '')} data-edge="io-link" style={{left:'61.9%',top:238}} onClick={() => select('io-link')}><Icon name="link" size={14}/><span>Modbus TCP<small>未连接</small></span></button>}
      {node('plc','OpenPLC','PLC 工程','code',400,18,'main','编辑器可用（演示）')}
      {node('runtime','OpenPLC Runtime','本机执行目标','chip',400,220,'runtime','未连接')}
      {node('hmi','FUXA','BatchPanel.fuxap','monitor',50,220,'hmi',tools.fuxa === 'ready' ? '服务可用 · 通信未连接' : tools.fuxa === 'error' ? '服务异常 · 通信未连接' : '服务待启动')}
      {tools.oip && node('scene','OIP','Conveyor.scene','box',750,220,'scene','已关联 · 场景未运行')}
      {!tools.oip && <div className="hx-unlinked-note"><Icon name="box" size={20}/><span>未关联仿真场景</span><small>从顶部“仿真场景”添加工程资源</small></div>}
    </div></div>
    <section className={'hx-info' + (infoOpen ? '' : ' is-collapsed')} aria-label="工程信息区">
      {infoOpen && <div className="hx-info-resizer" role="separator" aria-label="调整信息区高度" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={300} aria-valuenow={infoHeight} tabIndex={0} onPointerDown={event => {resizeStart.current={y:event.clientY,height:infoHeight};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event => {if(resizeStart.current)setInfoHeight(Math.max(120,Math.min(300,resizeStart.current.height+resizeStart.current.y-event.clientY)));}} onPointerUp={event => {resizeStart.current=null;event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={() => {resizeStart.current=null;}} onKeyDown={event => {if(['ArrowUp','ArrowDown','Home','End','Enter'].includes(event.key)){event.preventDefault();if(event.key==='Enter')setInfoOpen(false);else setInfoHeight(height=>event.key==='Home'?120:event.key==='End'?300:Math.max(120,Math.min(300,height+(event.key==='ArrowUp'?20:-20))));}}}><span/></div>}
      <div className="hx-info-tabs" role="tablist" aria-label="信息类型">{([{id:'properties',label:'属性',icon:'settings'},{id:'variables',label:'变量监视',icon:'branch'},{id:'diagnostics',label:'日志与诊断',icon:'file'}] as {id:HxInfoTab;label:string;icon:IconName}[]).map(item=><button type="button" role="tab" id={'hx-info-tab-'+item.id} aria-controls="hx-info-panel" aria-selected={infoTab===item.id && infoOpen} key={item.id} onClick={()=>{setInfoTab(item.id);setInfoOpen(true);}}><Icon name={item.icon} size={15}/>{item.label}</button>)}<span className="hx-selection-caption">{infoOpen ? selected.title : '选择资源、节点或连接查看详情'}</span><button type="button" className="hx-info-toggle" aria-label={infoOpen?'收起信息区':'展开信息区'} onClick={()=>setInfoOpen(!infoOpen)}><Icon name="chevron" size={15} className={infoOpen?'ni-down':'ni-up'}/>{infoOpen?'收起':'展开'}</button></div>
      {infoOpen && <div className="hx-info-content" id="hx-info-panel" role="tabpanel" aria-labelledby={'hx-info-tab-'+infoTab} style={{height:infoHeight}}>{infoTab==='properties'?<><div className="hx-property-heading"><Icon name={selected.icon} size={20}/><div><h3>{selected.title}</h3><p>{selected.description}</p></div>{selected.id==='candidate'&&ownedCandidate?<button type="button" className="ni-btn" onClick={onReviewCandidate}>审阅候选成果<Icon name="arrow" size={13}/></button>:selected.nodes.length===1&&selected.id!=='runtime'?<button type="button" className="ni-btn" onClick={()=>openTool(selected.nodes[0])}>在{selected.nodes[0]==='plc'?' OpenPLC':selected.nodes[0]==='hmi'?' FUXA':' OIP'} 中打开<Icon name="arrow" size={13}/></button>:null}</div><dl className="hx-property-grid">{propertyRows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></>:infoTab==='variables'?<><div className="hx-property-heading"><Icon name="branch" size={20}/><div><h3>{resource.name} · 变量监视</h3><p>Runtime 未连接，暂不提供实时值。以下为工程声明示意。</p></div><span className="hx-demo-label">只读</span></div><table className="hx-variable-table"><thead><tr><th>变量</th><th>类型</th><th>值</th><th>质量</th></tr></thead><tbody>{[['Count','INT'],['TargetCount','INT'],['StartReq','BOOL'],['Conveyor','BOOL']].map(([name,type])=><tr key={name}><td>{name}</td><td>{type}</td><td>--</td><td>未连接</td></tr>)}</tbody></table></>:<><div className="hx-property-heading"><Icon name="file" size={20}/><div><h3>{resource.name} · 日志与诊断</h3><p>仅记录本次原型查看操作；没有工具启动或 PLC 指令。</p></div></div><ul className="hx-event-list">{events.map((event,index)=><li key={index}><span>演示</span>{event}</li>)}</ul></>}</div>}
    </section>
    {environment&&<div className="hx-env-backdrop" onClick={event=>{if(event.target===event.currentTarget)setEnvironment(false);}}><section className="hx-env-dialog" role="dialog" aria-modal="true" aria-labelledby="hx-env-title"><header><div><h2 id="hx-env-title">开发环境</h2><p>{resource.name} · 软件与工程资源就绪情况</p></div><button type="button" className="ni-icon" aria-label="关闭开发环境" onClick={()=>setEnvironment(false)} autoFocus><Icon name="close" size={18}/></button></header><ToolchainReadiness key={project} project={project} state={state} onChange={onToolChange}/><footer>演示状态 · 本页操作不会启动软件或 Runtime</footer></section></div>}
  </section>;
}


export const PLCdevDSH = () => {
  const [sessions, setSessions] = useState(readNative);
  const [session, setSession] = useState<'main' | 'second'>('main');
  const [view, setView] = useState<'chat' | 'projects'>(() => window.location.hash === '#conversation' ? 'chat' : 'projects');
  const [overviewProject, setOverviewProject] = useState<ToolchainProject>('a');
  const [toolchain, setToolchain] = useState<ToolchainState>({
    a: { fuxa: 'ready', oip: true },
    b: { fuxa: 'stopped', oip: false }
  });
  const [nativeView, setNativeView] = useState<'chat' | 'trajectory'>('chat');
  const [panel, setPanel] = useState(false);
  const [tab, setTab] = useState<NativeTab>('hmi');
  const [selectedId, setSelectedId] = useState('T-014');
  const [draft, setDraft] = useState('');
  const [bindMenu, setBindMenu] = useState(false);
  const [hostMenu, setHostMenu] = useState<'team' | 'jobs' | 'files' | null>(null);
  const [legend, setLegend] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState('');
  const [simCount, setSimCount] = useState(0);
  const [simRunning, setSimRunning] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const current = sessions[session];
  const latest = current.tasks[current.tasks.length - 1];
  const selected = current.tasks.find(t => t.id === selectedId) || latest;
  const binding = current.binding ? nativeProjects[current.binding] : null;
  const busy = current.tasks.some(t => t.phase === 'generating');
  const selectedReady = selected && ['review', 'kept'].includes(selected.phase);
  const taskProject = selected ? nativeProjects[selected.project] : null;
  const overviewResult = (['main', 'second'] as const).flatMap(owner => sessions[owner].tasks.map(task => ({
    owner,
    task
  }))).filter(result => result.task.project === overviewProject).at(-1);
  useEffect(() => {
    window.history.replaceState(null, '', view === 'chat' ? '#conversation' : '#overview');
  }, [view]);
  useEffect(() => {
    const onHash = () => setView(window.location.hash === '#conversation' ? 'chat' : 'projects');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const patchTask = (id: string, patch: Partial<Candidate>) => setSessions(old => ({
    ...old,
    [session]: {
      ...old[session],
      tasks: old[session].tasks.map(t => t.id === id ? {
        ...t,
        ...patch
      } : t)
    }
  }));
  useEffect(() => {
    try {
      localStorage.setItem(nativeKey, JSON.stringify({
        schema: 2,
        sessions
      }));
    } catch {}
  }, [sessions]);
  useEffect(() => {
    const timer = setInterval(() => setSessions(old => {
      let changed = false;
      const next = {
        ...old
      };
      for (const id of ['main', 'second'] as const) {
        const tasks = old[id].tasks.map(t => {
          if (t.phase !== 'generating') return t;
          changed = true;
          return {
            ...t,
            step: Math.min(4, t.step + 1),
            phase: t.step >= 3 ? 'review' as const : 'generating' as const
          };
        });
        next[id] = {
          ...old[id],
          tasks
        };
      }
      return changed ? next : old;
    }), 900);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 3800);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    setSimCount(0);
    setSimRunning(false);
  }, [selected?.id, selected?.target, tab, session]);
  useEffect(() => {
    if (!simRunning || !selected) return;
    const timer = setInterval(() => setSimCount(n => Math.min(selected.target, n + 1)), 550);
    return () => clearInterval(timer);
  }, [simRunning, selected?.target]);
  useEffect(() => {
    if (selected && simCount >= selected.target) setSimRunning(false);
  }, [simCount, selected?.target]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBindMenu(false);
        setHostMenu(null);
        setMobileNav(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  function switchSession(id: 'main' | 'second') {
    setSession(id);
    setPanel(false);
    setView('chat');
    setNativeView('chat');
    setDraft('');
    setBindMenu(false);
    setMobileNav(false);
    setSelectedId(sessions[id].tasks.at(-1)?.id || '');
  }
  function bind(id: 'a' | 'b') {
    setSessions(old => ({
      ...old,
      [session]: {
        ...old[session],
        binding: id
      }
    }));
    setBindMenu(false);
    setView('chat');
    setToast(`后续需求使用${nativeProjects[id].name}；已有成果仍归属原工程。`);
  }
  function showOverview() {
    if (current.binding) setOverviewProject(current.binding);
    setView('projects');
    setBindMenu(false);
    setHostMenu(null);
    setMobileNav(false);
  }
  function enterProjectConversation() {
    const destination = (['main', 'second'] as const).find(id => sessions[id].binding === overviewProject) || 'second';
    setSessions(old => ({
      ...old,
      [destination]: {
        ...old[destination],
        binding: overviewProject
      }
    }));
    switchSession(destination);
  }
  function reviewOverviewResult() {
    if (!overviewResult) return;
    switchSession(overviewResult.owner);
    openReview(overviewResult.task);
  }
  function openReview(task: Candidate, next: NativeTab = 'hmi') {
    setSelectedId(task.id);
    setTab(next);
    setPanel(true);
    setHostMenu(null);
  }
  function submit(text: string) {
    if (busy) return;
    if (!current.binding) {
      setBindMenu(true);
      setToast('先为当前会话关联一个 PLC 工程。');
      return;
    }
    const value = text.trim();
    if (!value) return;
    const count = value.match(/(?:计满|目标(?:数量)?(?:改(?:成|为))?|改成|改为)\s*(\d+)\s*(?:件)?/);
    const delay = value.match(/延时\s*(\d+(?:\.\d+)?)\s*秒|([\d.]+)\s*秒启动延时/);
    if (!count && !delay) {
      setToast('本原型支持“目标改为 8 件”或“延时 3 秒”的需求演示。');
      return;
    }
    const previous = latest?.project === current.binding ? latest : undefined;
    const target = count ? Number(count[1]) : previous?.target ?? 5;
    const delayValue = delay ? Number(delay[1] ?? delay[2]) : previous?.delay ?? 3;
    if (target < 1 || target > 1000 || delayValue < 0 || delayValue > 60) {
      setToast('演示范围：目标 1–1000 件，延时 0–60 秒。');
      return;
    }
    const task: Candidate = {
      id: previous?.id || `T-${String(Date.now()).slice(-6)}`,
      project: current.binding,
      version: (previous?.version || 0) + 1,
      target,
      delay: delayValue,
      prompt: previous?.prompt || value,
      feedback: previous ? value : '',
      phase: 'generating',
      step: 0
    };
    setSessions(old => ({
      ...old,
      [session]: {
        ...old[session],
        tasks: previous ? old[session].tasks.map(t => t.id === previous.id ? task : t) : [...old[session].tasks, task]
      }
    }));
    setSelectedId(task.id);
    setDraft('');
    setNativeView('chat');
  }
  function stopAI() {
    setSessions(old => ({
      ...old,
      [session]: {
        ...old[session],
        tasks: old[session].tasks.map(t => t.phase === 'generating' ? {
          ...t,
          phase: 'paused'
        } : t)
      }
    }));
    setToast('已暂停本轮候选生成。此按钮只控制 AI 任务。');
  }
  const chips = [{
    tab: 'plc' as NativeTab,
    icon: 'code' as IconName,
    title: 'PLC 逻辑',
    detail: '梯形图与控制参数'
  }, {
    tab: 'hmi' as NativeTab,
    icon: 'monitor' as IconName,
    title: 'HMI 画面',
    detail: '计数与操作界面'
  }, {
    tab: 'binding' as NativeTab,
    icon: 'box' as IconName,
    title: '场景绑定',
    detail: 'OIP 与工程变量'
  }];
  const mainTitle = session === 'main' ? '输送带批次计数' : '新的工程会话';
  return <div className={'ni-root ' + (legend ? 'ni-show-zones' : '')}>
    <div className="ni-design-bar"><span>PLCdev × DSH <i />原生界面融合方案</span><div><span>交互示意</span><button aria-pressed={legend} onClick={() => setLegend(!legend)}><Icon name="layers" size={13} />{legend ? '隐藏插件标记' : '标出插件区域'}</button></div></div>
    <div className="ni-window">
      <aside className={'ni-sidebar ' + (mobileNav ? 'open' : '')}>
        <div className="ni-brand"><span className="ni-brand-mark">◒</span><strong>deepseek</strong><small>HARNESS</small></div>
        <button className="ni-new-session" onClick={() => switchSession('second')}><Icon name="plus" size={18} />新会话</button>
        <nav className="ni-global-nav" aria-label="DSH 导航"><span><Icon name="grid" size={19} />插件</span><button className={view === 'projects' ? 'active' : ''} onClick={showOverview}><Icon name="chip" size={19} />PLCdev<span className="ni-nav-badge">工程总览</span></button><span><Icon name="clock" size={19} />自动化任务</span><span><Icon name="dots" size={19} />更多</span></nav>
        <div className="ni-workspace-label"><span>工作区</span><span><Icon name="search" size={15} /><Icon name="settings" size={15} /></span></div>
        <div className="ni-workspace-title"><Icon name="folder" size={19} />PLCdev</div>
        <div className="ni-sessions"><button className={session === 'main' && view === 'chat' ? 'active' : ''} onClick={() => switchSession('main')}>输送带批次计数<span>刚刚</span></button><button className={session === 'second' && view === 'chat' ? 'active' : ''} onClick={() => switchSession('second')}>新的工程会话<span>今天</span></button><div>变量命名与绑定<span>昨天</span></div></div>
        <div className="ni-workspace-title muted"><Icon name="folder" size={18} />其他工作区</div>
        <div className="ni-sidebar-bottom"><span className="ni-user-icon">W</span><span>个人工作空间</span></div>
      </aside>

      <main className="ni-main">
        {view === 'chat' ? <><header className="ni-session-header"><div className="ni-chat-page-label"><span>工程对话</span><button className="ni-overview-link" onClick={showOverview}><Icon name="grid" size={13} />工程总览<Icon name="arrow" size={12} /></button></div><div className="ni-title-row"><button className="ni-mobile-toggle ni-icon" aria-label="切换 DSH 侧栏" onClick={() => setMobileNav(!mobileNav)}><Icon name="grid" /></button><h1>{mainTitle}</h1><div className="ni-native-actions"><button onClick={() => setHostMenu(hostMenu === 'team' ? null : 'team')}><Icon name="layers" size={15} />智能体团队</button><button onClick={() => setHostMenu(hostMenu === 'jobs' ? null : 'jobs')}><span className={'ni-activity-dot ' + (busy ? 'busy' : '')} />{busy ? '候选生成中' : '后台任务'}<Icon name="chevron" size={12} className="ni-down" /></button></div><div className="ni-header-right"><button className="ni-engineering-pill ni-plugin-zone" data-zone="1" onClick={() => selected ? openReview(selected) : setToast('当前会话还没有可审阅成果。')}><Icon name="layers" size={15} />工程成果{latest && <span>{current.tasks.length}</span>}</button><button className="ni-icon" aria-label="原生文件入口" onClick={() => setHostMenu(hostMenu === 'files' ? null : 'files')}><Icon name="folder" size={18} /></button><button className="ni-icon" aria-label="切换右侧审阅栏" onClick={() => selected ? setPanel(!panel) : setToast('当前会话还没有可审阅成果。')}><Icon name="monitor" size={18} /></button></div></div>
          <div className="ni-native-tabs"><button className={nativeView === 'chat' ? 'active' : ''} onClick={() => setNativeView('chat')}>对话</button><button className={nativeView === 'trajectory' ? 'active' : ''} onClick={() => setNativeView('trajectory')}>轨迹</button><span>···</span></div>
          {hostMenu && <div className="ni-host-popover"><header><b>{hostMenu === 'team' ? 'DSH 团队与工具' : hostMenu === 'jobs' ? '后台任务' : '当前会话文件'}</b><button aria-label="关闭宿主菜单" onClick={() => setHostMenu(null)}><Icon name="close" size={15} /></button></header>{hostMenu === 'team' ? <><p>团队、模型与权限沿用 DSH。PLCdev 提供工程上下文和受控工具。</p><div className="ni-popover-items"><span>OpenPLC 适配 <small>程序候选</small></span><span>FUXA 适配 <small>原生画面</small></span><span>OIP 适配 <small>场景关联</small></span></div></> : hostMenu === 'jobs' ? <><p>{busy ? '候选生成正在演示中。' : '当前没有正在执行的 AI 任务。'}</p><div className="ni-popover-items"><span>PLC Runtime <small>未连接 · 单独管理</small></span></div><small>AI 轮次结束不表示 PLC 停止。</small></> : <><p>{binding?.file || '尚未关联 PLC 工程'}</p><small>沿用 DSH 的文件浏览器；本原型未打开本机文件。</small></>}</div>}
        </header>

        <div className={'ni-content ' + (panel ? 'ni-panel-open' : '')}>
          <section className="ni-chat" aria-label="DSH 原生会话">
            <div className="ni-chat-scroll">
              <div className="ni-message-width">
                {nativeView === 'trajectory' ? <div className="ni-trajectory"><span className="ni-overline">DSH 原生轨迹</span><h2>保留完整执行过程</h2><p>同一项工程任务的工具调用与候选卡相互关联。</p>{['读取已保存的工程版本', '生成 OpenPLC 逻辑候选', '同步 FUXA 与 OIP 关联', '发布联合候选摘要'].map((label, i) => <div className="ni-trace-row" key={label}><span>{latest && latest.step > i ? <Icon name="check" size={13} /> : i + 1}</span><div><b>{label}</b><small>{latest?.id || '暂无任务'} · {latest && latest.step > i ? '已完成（示意）' : '等待'}</small></div>{latest && i === 3 && ['review', 'kept'].includes(latest.phase) && <button onClick={() => {
                        setNativeView('chat');
                        openReview(latest);
                      }}>查看成果<Icon name="arrow" size={13} /></button>}</div>)}</div> : current.tasks.length === 0 ? <div className="ni-empty"><Icon name="chip" size={34} /><h2>继续在 DSH 里，说清楚要做什么。</h2><p>关联一个 PLC 工程后，就能在当前会话中生成、审阅和继续修改成果。</p><button className="ni-btn" onClick={() => {
                      setDraft(nativePrompt);
                      if (!current.binding) setBindMenu(true);
                      input.current?.focus();
                    }}>试试输送带批次计数<Icon name="arrow" size={15} /></button></div> : current.tasks.map((task, idx) => <div className={'ni-turn ' + (idx < current.tasks.length - 1 ? 'past' : '')} key={task.id}>
                  <div className="ni-turn-date">{idx === current.tasks.length - 1 ? '当前任务' : '此前任务'} · {nativeProjects[task.project].name}</div>
                  <div className="ni-user-message">{task.prompt}</div>
                  <details className="ni-tool-trace"><summary><Icon name="chevron" size={13} /><span>已读取工程与变量声明，已调用专业工具</span><small>4 个步骤</small></summary><div><span>读取 · {nativeProjects[task.project].file}</span><span>生成 · PLC / FUXA / OIP 联合候选</span><button onClick={() => setNativeView('trajectory')}>在 DSH 轨迹中查看<Icon name="arrow" size={12} /></button></div></details>
                  <p className="ni-assistant-text">{task.phase === 'generating' ? '正在整理逻辑、画面与场景关联，结果会汇总到下面这张工程成果卡。' : task.phase === 'paused' ? '本轮候选生成已暂停，已完成的步骤会保留。' : '已把启动延时和批次目标同步到三个成果。可以打开审阅，也可以直接在下方继续提出修改。'}</p>
                  <article className="ni-artifact-card ni-plugin-zone" data-zone="2" aria-label={'PLCdev 成果 ' + task.id}>
                    <div className="ni-card-top"><span className="ni-plugin-icon"><Icon name="chip" size={19} /></span><div><h2>批次控制 · 联合候选</h2><span>PLCdev <i /> {nativeProjects[task.project].name} <i /> {task.id}</span></div><span className={'ni-task-state ' + task.phase}>{{
                            review: '待审阅',
                            kept: '已保留',
                            generating: '生成中',
                            paused: '已暂停'
                          }[task.phase]}</span></div>
                    <div className="ni-card-meta"><span>延时 <b>{task.delay} 秒</b></span><span>目标 <b>{task.target} 件</b></span><span>{nativeProjects[task.project].version} <Icon name="arrow" size={11} />候选 v{task.version}</span></div>
                    {['review', 'kept'].includes(task.phase) ? <><div className="ni-artifact-tiles">{chips.map(c => <button key={c.tab} onClick={() => openReview(task, c.tab)}><Icon name={c.icon} size={22} /><b>{c.title}</b><small>{c.detail}</small><Icon name="chevron" size={13} /></button>)}</div><div className="ni-card-footer"><span>3 项成果 · 待编译验证</span><button onClick={() => openReview(task)}>审阅这组成果<Icon name="arrow" size={14} /></button></div></> : <div className="ni-task-progress"><div><span>{['固定源工程版本', '生成 PLC 控制逻辑', '同步画面与场景', '整理联合候选'][Math.min(3, task.step)]}</span><span>{task.step}/4</span></div><div className="ni-progress-track"><i style={{
                            width: (task.step + 0.5) * 25 + '%'
                          }} /></div><button onClick={() => patchTask(task.id, {
                          phase: task.phase === 'paused' ? 'generating' : 'paused'
                        })}><Icon name={task.phase === 'paused' ? 'play' : 'pause'} size={13} />{task.phase === 'paused' ? '继续候选生成' : '暂停候选生成'}</button></div>}
                  </article>
                  {task.feedback && <p className="ni-feedback"><Icon name="check" size={13} />已接收修改：{task.feedback}{task.phase === 'review' && ' · 三端参数已同步'}</p>}
                </div>)}
              </div>
            </div>
            <div className="ni-composer-wrap">
              <div className="ni-message-width">
                <div className="ni-context-dock ni-plugin-zone" data-zone="3"><button onClick={() => setBindMenu(!bindMenu)} aria-expanded={bindMenu}><span className="ni-context-tag"><Icon name="chip" size={13} />PLCdev</span><Icon name="folder" size={14} /><b>{binding ? binding.name : '关联 PLC 工程'}</b>{binding && <small>{binding.version} 已保存</small>}<Icon name="chevron" size={11} className="ni-down" /></button><button className="ni-runtime-chip" onClick={() => selected && selected.project === current.binding ? openReview(selected, 'topology') : setToast(binding ? `${binding.name}尚未建立运行会话。` : 'Runtime 状态在关联工程后独立查看。')}><span />Runtime 未连接</button>
                  {bindMenu && <div className="ni-bind-menu"><b>为后续需求关联工程</b><p>已有成果继续归属其生成时的工程。</p>{(['a', 'b'] as const).map(id => <button key={id} onClick={() => bind(id)}><Icon name="folder" size={17} /><span>{nativeProjects[id].name}<small>{nativeProjects[id].file} · {nativeProjects[id].version}</small></span>{current.binding === id && <Icon name="check" size={15} />}</button>)}</div>}
                </div>
                <form className="ni-native-composer" onSubmit={e => {
                    e.preventDefault();
                    submit(draft);
                  }}><label className="ni-sr" htmlFor="ni-prompt">DSH 原生消息输入框</label><textarea id="ni-prompt" ref={input} value={draft} onChange={e => setDraft(e.target.value)} placeholder="发消息或创建任务，/ 调用指令，@ 文件或对话" onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        submit(draft);
                      }
                    }} /><div className="ni-native-composer-actions"><div><span className="ni-native-add"><Icon name="plus" size={22} /></span><span className="ni-permission"><Icon name="layers" size={15} />工作区内修改<Icon name="chevron" size={11} className="ni-down" /></span></div><div><span className="ni-model">DeepSeek-V4.1-Flash <small>Max</small><Icon name="chevron" size={11} className="ni-down" /></span>{busy ? <button className="ni-submit busy" type="button" aria-label="停止当前 AI 轮次" onClick={stopAI}><span /></button> : <button className="ni-submit" type="submit" aria-label="发送工程需求" disabled={!draft.trim()}><Icon name="arrow" size={21} className="ni-up" /></button>}</div></div></form>
                <div className="ni-composer-bottom"><span>模型、权限与输入由 DSH 承载</span><span>基于已保存工程生成候选</span></div>
              </div>
            </div>
          </section>

          {panel && <aside className="ni-rightbar" aria-label="DSH 右侧 PLCdev 审阅标签页"><div className="ni-rightbar-chrome"><button className="ni-back" onClick={() => setPanel(false)}><Icon name="chevron" className="ni-left" size={13} />返回对话</button><span><Icon name="chip" size={15} />PLCdev · 工程成果</span><button className="ni-icon" aria-label="关闭审阅栏" onClick={() => setPanel(false)}><Icon name="close" size={16} /></button></div><div className="ni-review-body ni-plugin-zone" data-zone="4">
            <div className="ni-review-title"><span className="ni-overline">{taskProject?.name} · {selected?.id}</span><h2>{tab === 'topology' ? '工程与运行状态' : '审阅联合候选'}<span>v{selected?.version}</span></h2><p>源版本 {taskProject?.version} · 独立候选副本</p></div>
            <div className="ni-review-tabs" role="tablist" aria-label="PLCdev 成果类型">{[{
                    id: 'hmi',
                    label: '画面'
                  }, {
                    id: 'plc',
                    label: '逻辑'
                  }, {
                    id: 'binding',
                    label: '绑定'
                  }, {
                    id: 'topology',
                    label: '拓扑'
                  }].map(t => <button id={'ni-tab-' + t.id} role="tab" key={t.id} aria-selected={tab === t.id} aria-controls="ni-panel" onClick={() => setTab(t.id as NativeTab)}>{t.label}</button>)}</div>
            <div className="ni-review-scroll" role="tabpanel" id="ni-panel" aria-labelledby={'ni-tab-' + tab}>
              {!selectedReady ? <div className="ni-awaiting"><Icon name="layers" size={30} /><b>候选尚未就绪</b><p>可回到对话查看进度。关闭审阅区不会停止任务。</p></div> : tab === 'hmi' ? <><div className="ni-preview-label"><span>FUXA · BatchPanel</span><span>候选示意</span></div><div className="ni-hmi"><header><b>输送带批次控制</b><span>{simRunning ? '演示计数' : '待启动'}</span></header><div className="ni-hmi-metrics"><div><span>当前计数</span><strong>{String(simCount).padStart(2, '0')}<small>/ {String(selected.target).padStart(2, '0')}</small></strong></div><div><span>启动延时</span><strong>{selected.delay}<small>秒</small></strong></div></div><Conveyor moving={simRunning} /><div className="ni-hmi-buttons"><button onClick={() => {
                          setSimCount(0);
                          setSimRunning(true);
                        }} disabled={simRunning}><Icon name="play" size={12} />预演画面</button><button onClick={() => {
                          setSimCount(0);
                          setSimRunning(false);
                        }}><Icon name="refresh" size={12} />重置</button></div><small className="ni-preview-footnote">仅页面动画 · 无 PLC 通信</small></div><div className="ni-diff"><h3>本次参数变化</h3><div><span>启动延时</span><del>1 秒</del><Icon name="arrow" size={13} /><b>{selected.delay} 秒</b></div><div><span>批次目标</span><del>3 件</del><Icon name="arrow" size={13} /><b>{selected.target} 件</b></div></div></> : tab === 'plc' ? <><div className="ni-preview-label"><span>OpenPLC · BatchMain</span><span>LD</span></div><div className="ni-ladder"><div className="ni-rung-title">NETWORK 01 · 延时启动</div><div className="ni-rung"><span><small>RunReq</small>│ │</span><div><b>TON</b><small>PT <strong>T#{selected.delay}s</strong></small></div><span><small>Motor</small>（ ）</span></div><div className="ni-rung-title">NETWORK 02 · 批次完成</div><div className="ni-rung"><span><small>BoxPulse</small>│↑│</span><div><b>CTU</b><small>PV <strong>{selected.target}</strong></small></div><span><small>Done</small>（ ）</span></div></div><p className="ni-small-note">此处显示关键参数差异。完整程序通过 OpenPLC 原生编辑器继续审阅。</p></> : tab === 'binding' ? <><div className="ni-preview-label"><span>同一份工程变量声明</span><span>5 项</span></div><table className="ni-binding-table"><thead><tr><th>变量</th><th>使用位置</th><th>方向</th></tr></thead><tbody>{[['Count', 'HMI 当前计数', '只读'], ['TargetCount', `HMI 目标 ${selected.target} 件`, '请求'], ['StartReq', 'HMI 启动按钮', '请求'], ['BoxSensor', 'OIP 光电传感器', '输入'], ['Conveyor', 'OIP 输送带', '输出']].map(row => <tr key={row[0]}>{row.map((text, i) => <td key={i}>{text}</td>)}</tr>)}</tbody></table><p className="ni-small-note">成果卡与右侧审阅引用同一个候选任务；修改意见仍从 DSH 输入框发送。</p></> : <><div className="ni-topology-diagram"><div><Icon name="code" /><b>OpenPLC</b><small>程序候选</small></div><span>编译装载 · 未执行</span><div className="ni-runtime-node"><Icon name="chip" /><b>Runtime</b><small>未连接</small></div><span>运行通信 · 未建立</span><section><div><Icon name="monitor" /><b>FUXA HMI</b></div><div><Icon name="box" /><b>OIP 场景</b></div></section></div><div className="ni-runtime-explanation"><b>运行会话独立于 AI 对话</b><p>切换会话、关闭侧栏、停止 AI 生成，都不发送 PLC 停止指令。</p><span>准备运行</span><small>状态尚未核验，当前不可用</small></div></>}
              {selectedReady && <div className="ni-review-evidence"><span><Icon name="check" size={12} />候选就绪</span><span>○ 待编译</span><span>○ 待运行验证</span></div>}
            </div>
            {selectedReady && <div className="ni-review-footer"><div><span>{selected.phase === 'kept' ? '候选已保留' : '保留为一组候选'}</span><small>尚未应用到原工程</small></div><button className={'ni-btn ' + (selected.phase === 'kept' ? '' : 'ni-primary')} onClick={() => {
                    patchTask(selected.id, {
                      phase: selected.phase === 'kept' ? 'review' : 'kept'
                    });
                    setToast(selected.phase === 'kept' ? '已撤销保留，源工程没有变化。' : '候选已保留；编译与运行仍需后续验证。');
                  }}><Icon name={selected.phase === 'kept' ? 'undo' : 'check'} size={14} />{selected.phase === 'kept' ? '撤销保留' : '保留候选'}</button></div>}
          </div></aside>}
        </div></> : <HorizontalWorkspace
          key={overviewProject}
          project={overviewProject}
          onProjectChange={setOverviewProject}
          state={toolchain}
          onToolChange={(id, patch) => setToolchain(old => ({...old, [id]: {...old[id], ...patch}}))}
          candidate={overviewResult?.task}
          onEnterConversation={enterProjectConversation}
          onReviewCandidate={reviewOverviewResult}
          onReturnConversation={() => setView('chat')}
          onNotify={setToast}
        />}
        <div className="ni-prototype-footer"><span>原型演示 · 未连接真实工具服务</span><span>DSH 承载会话 · PLCdev 提供工程能力</span></div>
      </main>
    </div>
    {legend && <div className="ni-zone-legend"><span><i>1</i>标题工具入口</span><span><i>2</i>对话成果卡</span><span><i>3</i>输入前工程上下文</span><span><i>4</i>原生侧栏中的审阅页</span><button onClick={() => latest ? openReview(latest) : setToast('先生成一组候选。')}>展开审阅区<Icon name="arrow" size={13} /></button></div>}
    {toast && <div className="ni-toast" role="status"><Icon name="check" size={15} />{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><Icon name="close" size={13} /></button></div>}
  </div>;
};