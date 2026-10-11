import React, { useState, useEffect, useRef } from 'react';
import { Folder, FolderOpen, FolderPlus, ArrowRight, ArrowUpRight, Check, CheckCircle2, X,
  Plus, Settings2, Layers3, History, ShieldCheck, HardDrive, Download, RefreshCw, LoaderCircle,
  File, FileText, FileImage, FileVideo, FileAudio, FileArchive, FileCode, FileSpreadsheet,
  ChevronDown, Pencil, GripVertical, AlertCircle, Terminal, Circle, Cpu, ArrowLeft, Trash2 } from 'lucide-react';
import { call, connect, subscribe, desktop, chooseDirectories, revealDirectory, disconnect } from './bridge.js';
const basename = (s) => s.split(/[\\/]/).filter(Boolean).at(-1) ?? s;
const bytes = (n = 0) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`;
const date = (v) => new Date(v).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const countFiles = (p) => p?.roots.reduce((n, r) => n + r.groups.reduce((m, g) => m + g.files.length, 0), 0) ?? 0;
const countFolders = (p) => p?.roots.reduce((n, r) => n + r.groups.filter((g) => g.files.length).length, 0) ?? 0;
function FileIcon({ name }) {
  const ext = name.split('.').at(-1).toLowerCase();
  const [Icon, kind] = ['pdf','doc','docx','txt','md','rtf'].includes(ext) ? [FileText, 'document']
    : ['xls','xlsx','csv','ods'].includes(ext) ? [FileSpreadsheet, 'sheet']
    : ['png','jpg','jpeg','svg','gif','webp','heic'].includes(ext) ? [FileImage, 'image']
    : ['mp4','mov','mkv','avi','webm'].includes(ext) ? [FileVideo, 'video']
    : ['mp3','wav','flac','ogg','m4a'].includes(ext) ? [FileAudio, 'audio']
    : ['zip','rar','7z','tar','gz'].includes(ext) ? [FileArchive, 'archive']
    : ['js','ts','tsx','jsx','py','json','html','css','rs'].includes(ext) ? [FileCode, 'code'] : [File, 'generic'];
  return <span className={`file-symbol ${kind}`}><Icon size={18}/></span>;
}
function Modal({ title, children, onClose }) {
  const ref = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => [...ref.current.querySelectorAll('button,input,select,[tabindex="0"]')].filter((el) => !el.disabled);
    focusable()[0]?.focus();
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') { const items = focusable(), first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
      <div className="modal-title"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20}/></button></div>{children}
    </div></div>;
}
function LogPanel({ logs, busy, moveProgress, download, expanded = false }) {
  const [open, setOpen] = useState(expanded); const end = useRef();
  useEffect(() => { if (open || busy) end.current?.scrollIntoView({ block: 'nearest' }); }, [logs.length, open, busy]);
  const progress = moveProgress?.total ? moveProgress.completed / moveProgress.total * 100 : download?.percent;
  return <section className={`logs-panel ${busy ? 'running' : ''}`}>
    <button className="logs-heading" onClick={() => setOpen(!open)} aria-expanded={open || Boolean(busy)}>
      <span><Terminal size={17}/> {busy ? 'Live activity' : 'Activity log'} {busy && <LoaderCircle className="spin" size={14}/>}</span>
      <span className="log-caption">{busy ? (moveProgress ? `${moveProgress.completed} / ${moveProgress.total} files` : download?.status ?? 'Working locally') : `${logs.length} recorded events`}<ChevronDown size={16} className={open || busy ? 'rotated' : ''}/></span>
    </button>
    {busy && Number.isFinite(progress) && <div className="progress-track"><div style={{ width: `${progress}%` }}/></div>}
    {(open || busy) && <div className="log-lines" role="log" aria-live="polite" aria-label="Operation log">
      {logs.length ? logs.slice(-150).map((entry) => <div className={`log-line ${entry.level}`} key={entry.id}>
        <time>{new Date(entry.time).toLocaleTimeString('en', { hour12: false })}</time>
        {entry.level === 'success' ? <Check size={13}/> : entry.level === 'error' || entry.level === 'warning' ? <AlertCircle size={13}/> : <Circle size={9}/>}
        <span>{entry.message}</span></div>) : <p className="quiet">Your real operations will appear here.</p>}<div ref={end}/>
    </div>}
  </section>;
}
function FolderCard({ group, root, editable, busy, edit, error, onDirty }) {
  const [renaming, setRenaming] = useState(false), [name, setName] = useState(group.folder), [over, setOver] = useState(false);
  useEffect(() => setName(group.folder), [group.folder]);
  useEffect(() => () => onDirty(group.id, false), []);
  const rename = async (e) => {
    e.preventDefault(); if (name !== group.folder) { const ok = await edit({ action: 'rename_group', rootId: root.id, groupId: group.id, name }); if (!ok) return; }
    onDirty(group.id, false); setRenaming(false);
  };
  return <article className={`folder-card ${over ? 'drag-over' : ''}`} onDragOver={(e) => {
    if (editable && !busy && e.dataTransfer.types.includes('application/clean-folder')) { e.preventDefault(); setOver(true); }
  }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }} onDrop={async (e) => {
    e.preventDefault(); setOver(false); if (!editable || busy) return;
    try { const item = JSON.parse(e.dataTransfer.getData('application/clean-folder'));
      if (item.rootId !== root.id) throw new Error('Move files between folders inside the same source directory.');
      await edit({ action: 'move_file', rootId: root.id, groupId: item.groupId, file: item.name, destinationGroupId: group.id });
    } catch (err) { error(err.message); }
  }}>
    <div className="folder-card-head"><div className="folder-symbol"><Folder size={26}/></div>
      <div className="folder-heading">{renaming ? <form onSubmit={rename} className="rename-form">
        <input aria-label="New folder name" value={name} onChange={(e) => { setName(e.target.value); onDirty(group.id, e.target.value !== group.folder); }} maxLength={80} autoFocus disabled={busy}/>
        <button className="icon-button" type="submit" aria-label="Save folder name" disabled={busy}><Check size={17}/></button>
        <button className="icon-button" type="button" aria-label="Cancel rename" onClick={() => { setName(group.folder); onDirty(group.id, false); setRenaming(false); }}><X size={16}/></button></form>
        : <><h3 title={group.folder}>{group.folder}</h3><span>{group.files.length} {group.files.length === 1 ? 'file' : 'files'}</span></>}
      </div>{editable && !renaming && <button className="icon-button edit-folder" aria-label={`Rename ${group.folder}`} title="Rename folder" onClick={() => setRenaming(true)} disabled={busy}><Pencil size={16}/></button>}
    </div>
    <div className="folder-files">{group.files.length ? group.files.map((file) => <div className="file-row" key={file.name} draggable={editable && !busy}
      onDragStart={(e) => { e.dataTransfer.setData('application/clean-folder', JSON.stringify({ rootId: root.id, groupId: group.id, name: file.name })); e.dataTransfer.effectAllowed = 'move'; }}>
      {editable && <GripVertical size={14} className="drag-handle"/>}<FileIcon name={file.name}/>
      <div className="file-description"><span title={file.name}>{file.name}</span><small>{bytes(file.size)}</small></div>
      {editable && <label className="file-move"><ArrowUpRight size={16}/><select aria-label={`Move ${file.name}`} value={group.id} disabled={busy}
        onChange={(e) => edit({ action: 'move_file', rootId: root.id, groupId: group.id, file: file.name, destinationGroupId: e.target.value })}>
        {root.groups.map((destination) => <option key={destination.id} value={destination.id}>{destination.folder}</option>)}</select></label>}
    </div>) : <div className="empty-group"><FolderPlus size={20}/><span>Drop files here to include this folder.</span></div>}</div>
  </article>;
}

export default function App() {
  const [page, setPage] = useState('organize'), [state, setState] = useState(null), [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState([]), [rootId, setRootId] = useState(null), [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(false), [logs, setLogs] = useState([]), [download, setDownload] = useState(null), [moveProgress, setMoveProgress] = useState(null);
  const [toast, setToast] = useState(null), [modal, setModal] = useState(null), [input, setInput] = useState(''), [modelName, setModelName] = useState('');
  const [preferences, setPreferences] = useState(null), [selectedRun, setSelectedRun] = useState(null);
  const [dirtyNames, setDirtyNames] = useState(new Set());
  const [dragging, setDragging] = useState(false);
  const onDirty = (id, dirty) => setDirtyNames((old) => { const next = new Set(old); dirty ? next.add(id) : next.delete(id); return next; });
  const busyRef = useRef(null), autoSetup = useRef(false), editLock = useRef(false);
  const notify = (message, kind = 'error') => setToast({ message, kind, id: Date.now() });
  const refresh = async () => { const next = await call('get_state'); setState(next); setPlan(next.currentPlan); setLogs(next.logs); setPreferences(next.settings); return next; };
  const perform = async (name, fn) => {
    if (busyRef.current) return; busyRef.current = name; setBusy(name); setDownload(null); setMoveProgress(null);
    try { return await fn(); } catch (error) { notify(error.message); return null; }
    finally { busyRef.current = null; setBusy(null); }
  };
  useEffect(() => {
    const unsubscribe = subscribe((event, data) => {
      if (event === 'log') setLogs((previous) => [...previous, data].slice(-3000));
      if (event === 'download') setDownload(data);
      if (event === 'move_progress') setMoveProgress(data);
      if (event === 'bridge_error') notify(data);
    });
    connect().then(refresh).then((next) => {
      if (next && !next.ready && !autoSetup.current) { autoSetup.current = true;
        perform('setup', async () => { await call('setup_runtime'); await refresh(); }); }
    }).catch((error) => notify(error.message));
    let removeClose;
    if (desktop) {
      import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        removeClose = await getCurrentWindow().onCloseRequested((event) => {
          if (busyRef.current || editLock.current) { event.preventDefault(); notify('Please keep Clean_folder open until the current operation finishes.', 'info'); }
          else disconnect().catch(() => {});
        });
      });
    }
    return () => { unsubscribe(); removeClose?.(); };
  }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(null), 6500); return () => clearTimeout(timer); } }, [toast]);
  const choose = async () => { try { const result = await chooseDirectories();
    if (result === null) { setInput(''); setModal('path'); } else setSelected((old) => [...new Set([...old, ...result])]);
  } catch (error) { notify(error.message); } };
  const analyze = () => perform('analysis', async () => {
    const next = await call('create_plan', { directories: selected }); setPlan(next); setRootId(next.roots[0]?.id); await refresh();
  });
  const edit = async (change) => {
    if (editLock.current || busyRef.current) return false;
    editLock.current = true; setEditing(true);
    try { const next = await call('edit_plan', { planId: plan.id, revision: plan.revision, ...change }); setPlan(next); return true; }
    catch (error) { notify(error.message); return false; }
    finally { editLock.current = false; setEditing(false); }
  };
  const organize = async () => { setModal(null); await perform('organizing', async () => {
    const result = await call('apply_plan', { planId: plan.id, revision: plan.revision }); setPlan(result.plan); await refresh();
    notify(result.run.errors ? `${result.run.moved} files organized. Review ${result.run.errors} errors in Activity.` : `${result.run.moved} files, beautifully organized.`, result.run.errors ? 'info' : 'success');
  }); };
  const finish = async () => { try { await call('archive_plan'); setPlan(null); setSelected([]); await refresh(); } catch (e) { notify(e.message); } };
  const savePreferences = async (next = preferences) => perform('preferences', async () => {
    await call('save_settings', { settings: next }); await refresh(); notify('Your preferences are saved.', 'success');
  });
  const install = async (e) => { e.preventDefault(); await perform('download', async () => {
    await call('install_model', { name: modelName.trim() }); setModelName(''); await refresh(); notify('Model installed and ready to select.', 'success');
  }); };
  const root = plan?.roots.find((r) => r.id === rootId) ?? plan?.roots[0];
  const locked = Boolean(busy) || editing, draft = plan?.status === 'draft';
  const headings = { organize: ['Organize', plan ? 'Make room for clarity.' : 'A little order. A lot of calm.'], models: ['Local models', 'The intelligence is yours.'],
    activity: ['Activity', 'Every move, accounted for.'], settings: ['Preferences', 'Make it feel like you.'] };
  const currentLogs = selectedRun ? logs.filter((l) => l.runId === selectedRun.id) : logs;
  return <div className={`app-shell ${dragging ? 'is-dragging' : ''}`} onDragStart={() => setDragging(true)} onDragEnd={() => setDragging(false)} onDrop={() => setDragging(false)}>
    <aside className="sidebar"><div className="brand"><img src="/logo.svg" alt="Clean_folder logo"/><div>Clean_folder<small>A place for everything.</small></div></div>
      <span className="nav-caption">WORKSPACE</span><nav aria-label="Main navigation">{[
        ['organize', FolderOpen, 'Organize'], ['models', Cpu, 'Models'], ['activity', History, 'Activity'], ['settings', Settings2, 'Preferences'],
      ].map(([id, Icon, label]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><Icon size={19}/>{label}{page === id && <span className="nav-dot"/>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={23}/><h3>Quietly local.</h3><p>Your files stay on your device. Your approval comes first.</p></div>
      <div className={`runtime-pill ${state?.ready ? 'ready' : ''}`}><span className="status-dot"/><div>{state?.ready ? 'Local engine ready' : busy === 'setup' ? 'Preparing local engine' : 'Engine needs attention'}<small>{state?.connected ? 'Ollama connected' : 'Ollama not connected'}</small></div></div>
      <span className="version">Clean_folder · 0.1.0</span></div>
    </aside>
    <main className="main-content">
      <header className="page-header"><div><span className="eyebrow">YOUR SPACE, IN ORDER</span><div className="breadcrumb">{headings[page][0]}<span>/</span><span>{page === 'organize' && plan ? 'Review your plan' : 'On this device'}</span></div></div><div className="local-badge"><HardDrive size={15}/>Private by design</div></header>
      <section className="page-title"><div><h1>{headings[page][1]}</h1><p>{page === 'organize' ? plan ? 'A thoughtful proposal. You have the final say.' : 'Turn a busy directory into a space that makes sense.'
        : page === 'models' ? 'Install, choose, and run your models on this computer.' : page === 'activity' ? 'Real operations. Saved locally. Nothing left to guess.' : 'Small adjustments, a smoother experience.'}</p></div>
        {page === 'organize' && !plan && <button className="button primary" onClick={choose} disabled={locked}><Plus size={18}/>Choose directories</button>}
        {page === 'models' && <button className="button secondary" onClick={() => perform('refresh', refresh)} disabled={locked}><RefreshCw size={16}/>Refresh</button>}
      </section>
      {!state && <div className="connection-card"><LoaderCircle className="spin" size={24}/><div><strong>Connecting to your local engine</strong><p>No file operation is running.</p></div><button className="button secondary" onClick={() => perform('connection', refresh)} disabled={locked}>Retry connection</button></div>}
      {state && !state.ready && <section className="setup-card"><div className="setup-icon">{busy === 'setup' ? <LoaderCircle className="spin" size={26}/> : <Download size={26}/>}</div>
        <div><span className="eyebrow">ONE-TIME PREPARATION</span><h2>{busy === 'setup' ? 'Making everything ready for you.' : 'Let’s prepare your local engine.'}</h2>
          <p>{busy === 'setup' ? 'Installing Ollama and downloading your models. File organization will be available when setup finishes.' : 'Ollama and both selected models need to be available. Downloads require internet; organization runs locally.'}</p>
          {download && busy === 'setup' && <div className="setup-progress"><span>{download.model ?? 'Ollama'} · {download.status}</span>{Number.isFinite(download.percent) && <><strong>{download.percent}%</strong><div className="progress-track"><div style={{ width: `${download.percent}%` }}/></div></>}</div>}
          {state.setup?.error && !busy && <p className="error-copy">{state.setup.error}</p>}
        </div><button className="button primary" onClick={() => perform('setup', async () => { await call('setup_runtime'); await refresh(); })} disabled={locked}>{busy === 'setup' ? 'Preparing…' : 'Retry setup'}<ArrowRight size={17}/></button></section>}

      {page === 'organize' && <>
        {!plan ? <>
          <div className="steps"><span className="current"><i>1</i>Choose directories</span><span><i>2</i>Shape your plan</span><span><i>3</i>Approve & organize</span></div>
          {!selected.length ? <section className="empty-workspace"><div className="folder-illustration"><div className="orbit-file one"><FileText size={24}/></div><div className="orbit-file two"><FileImage size={24}/></div><div className="illustration-folder"><FolderOpen size={66}/></div><span className="illustration-check"><Check size={19}/></span></div>
            <h2>A home for every file.</h2><p>Choose one directory or a few. We’ll suggest a layout<br/>you can review, rename, and make your own.</p>
            <button className="button dark" onClick={choose} disabled={locked}><FolderPlus size={18}/>Choose directories<ArrowRight size={17}/></button>
            <span className="subtle-inline"><ShieldCheck size={14}/>Nothing moves without your approval.</span>
          </section> : <section className="selected-panel"><div className="section-heading"><div><h2>Your selected directories</h2><p>Only files directly inside each directory will be organized.</p></div><span className="count-badge">{selected.length} selected</span></div>
            <div className="directory-list">{selected.map((directory) => <div className="directory-row" key={directory}><span className="directory-icon"><Folder size={25}/></span><div><h3>{basename(directory)}</h3><p title={directory}>{directory}</p></div><button className="icon-button" disabled={locked} aria-label={`Remove ${basename(directory)}`} onClick={() => setSelected((old) => old.filter((d) => d !== directory))}><X size={17}/></button></div>)}</div>
            <div className="selected-actions"><button className="button text" onClick={choose} disabled={locked}><Plus size={17}/>Add a directory</button><button className="button primary" onClick={analyze} disabled={locked || !state?.ready}>{busy === 'analysis' ? <LoaderCircle className="spin" size={17}/> : <Layers3 size={17}/>} {busy === 'analysis' ? 'Building your proposal…' : 'Create my plan'}<ArrowRight size={17}/></button></div>
          </section>}
          {Boolean(state?.recentDirectories.length) && <section className="recent-section"><div className="section-heading"><h2>Pick up where you left off</h2><span>Recent directories</span></div><div className="recent-grid">{state.recentDirectories.slice(0, 6).map((directory) => <button className="recent-card" key={directory} disabled={locked} onClick={() => setSelected((old) => [...new Set([...old, directory])])}><Folder size={23}/><div><strong>{basename(directory)}</strong><small title={directory}>{directory}</small></div><Plus size={17}/></button>)}</div></section>}
          <div className="trust-strip"><span><Layers3 size={18}/>A proposal before every move</span><span><Pencil size={18}/>Your layout, your choice</span><span><HardDrive size={18}/>Saved on this device</span></div>
        </> : <>
          <div className="review-summary"><div><span className="summary-icon"><Layers3 size={23}/></span><div><strong>{countFiles(plan)} files</strong><small>ready to find their place</small></div></div><div><span className="summary-icon"><Folder size={23}/></span><div><strong>{countFolders(plan)} folders</strong><small>in your proposed layout</small></div></div><div><span className="summary-icon"><HardDrive size={23}/></span><div><strong>{plan.roots.length} {plan.roots.length === 1 ? 'directory' : 'directories'}</strong><small>organized independently</small></div></div><span className={`plan-status ${plan.status}`}>{draft ? <><Pencil size={14}/>Your editable draft</> : <><CheckCircle2 size={14}/>{plan.status}</>}</span></div>
          <div className="review-toolbar"><div className="root-tabs" role="tablist" aria-label="Source directories">{plan.roots.map((r) => <button role="tab" aria-selected={root?.id === r.id} key={r.id} className={root?.id === r.id ? 'active' : ''} title={r.path} onClick={() => setRootId(r.id)}><Folder size={15}/>{basename(r.path)}</button>)}</div>
            {draft && <button className="button secondary small" disabled={locked} onClick={() => { setInput(''); setModal('folder'); }}><Plus size={15}/>New folder</button>}</div>
          <div className="source-path"><FolderOpen size={14}/><span title={root?.path}>{root?.path}</span>{root?.skipped > 0 && <small>{root.skipped} entries skipped</small>}</div>
          {draft && <p className="review-tip"><GripVertical size={16}/>Drag files between folders, or use their move menu. Rename a folder with the pencil.</p>}
          {root && <div className="folder-grid">{root.groups.map((group) => <FolderCard key={group.id} group={group} root={root} editable={draft} busy={locked} edit={edit} error={notify} onDirty={onDirty}/>)}</div>}
          {!countFiles(plan) && <div className="no-files"><FolderOpen size={32}/><h2>Already clear.</h2><p>No top-level files were found in these directories.</p></div>}
          {draft ? <div className="approval-bar"><div><ShieldCheck size={23}/><span><strong>You’re in control.</strong><small>{countFiles(plan) ? 'Only this reviewed plan will be applied. No analysis runs again.' : 'There are no files to move.'}</small></span></div><div className="approval-actions"><button className="button text" disabled={locked} onClick={() => setModal('discard')}>Discard draft</button><button className="button primary" disabled={locked || dirtyNames.size > 0 || !countFiles(plan)} title={dirtyNames.size ? "Save your folder names before approving" : "Approve this exact plan"} onClick={() => setModal('approve')}><Check size={18}/>Approve & organize</button></div></div>
          : <div className="completion-panel"><CheckCircle2 size={30}/><div><h2>{plan.status === 'completed' ? 'Everything has its place.' : plan.status === 'interrupted' ? 'This operation was interrupted.' : 'Some files need your attention.'}</h2><p>{plan.status === 'completed' ? 'Your move receipts are saved in Activity.' : 'Check the recorded moves and errors in Activity before creating a new plan.'}</p></div><button className="button secondary" onClick={() => setPage('activity')}>View activity</button><button className="button primary" onClick={finish} disabled={locked}>Start fresh<ArrowRight size={16}/></button></div>}
        </>}
      </>}

      {page === 'models' && <>
        <section className="model-install"><div><span className="eyebrow">EXPAND YOUR TOOLKIT</span><h2>Bring another model home.</h2><p>Enter an Ollama model tag. Once installed, select it for embeddings or folder naming.</p></div><form onSubmit={install}><label className="sr-only" htmlFor="model-name">Ollama model name</label><input id="model-name" placeholder="e.g. qwen3:1.7b" value={modelName} onChange={(e) => setModelName(e.target.value)} disabled={locked}/><button className="button primary" disabled={locked || !modelName.trim() || !state?.connected}><Download size={16}/>Install model</button></form></section>
        {busy === 'download' && <div className="download-card"><LoaderCircle className="spin" size={23}/><div><strong>{download?.model ?? modelName}</strong><p>{download?.status ?? 'Contacting Ollama…'}{Number.isFinite(download?.percent) ? ` · ${download.percent}%` : ''}</p>{Number.isFinite(download?.percent) && <div className="progress-track"><div style={{ width: `${download.percent}%` }}/></div>}</div><button className="button secondary" onClick={() => call('cancel_download').catch((e) => notify(e.message))}>Cancel download</button></div>}
        <div className="section-heading"><h2>Installed on this device</h2><span>{state?.models.length ?? 0} models</span></div>
        <div className="models-grid">{state?.models.map((model) => <article className="model-card" key={model.name}><div className="model-top"><span className="model-icon"><Cpu size={23}/></span><span className="model-size">{bytes(model.size)}</span></div><h3>{model.name}</h3><p>{model.parameterSize ? `${model.parameterSize} parameters · ` : ''}{model.local === false ? 'Remote model · not used by Clean_folder' : model.capabilities.includes('embedding') ? 'Embedding model' : model.capabilities.includes('completion') ? 'Text-generation model' : 'Capabilities unavailable'}</p>
          <div className="model-buttons">{model.local !== false && model.capabilities.includes('embedding') && <button className={`button small ${state.settings.embeddingModel === model.name ? 'chosen' : 'secondary'}`} disabled={locked || state.settings.embeddingModel === model.name} onClick={() => savePreferences({ ...state.settings, embeddingModel: model.name })}>{state.settings.embeddingModel === model.name ? <Check size={15}/> : <Layers3 size={15}/>} {state.settings.embeddingModel === model.name ? 'Selected for embeddings' : 'Use for embeddings'}</button>}
          {model.local !== false && model.capabilities.includes('completion') && <button className={`button small ${state.settings.model === model.name ? 'chosen' : 'secondary'}`} disabled={locked || state.settings.model === model.name} onClick={() => savePreferences({ ...state.settings, model: model.name })}>{state.settings.model === model.name ? <Check size={15}/> : <Pencil size={15}/>} {state.settings.model === model.name ? 'Selected for naming' : 'Use for naming'}</button>}</div></article>)}</div>
        {!state?.models.length && <div className="small-empty"><Cpu size={32}/><h3>No installed models yet.</h3><p>Complete setup or install a model above.</p></div>}
      </>}

      {page === 'activity' && <>
        {!state?.history.length ? <div className="small-empty large"><History size={42}/><h2>Your story starts with the first move.</h2><p>Completed and interrupted operations will appear here with their actual results.</p><button className="button secondary" onClick={() => setPage('organize')}>Go to Organize<ArrowRight size={16}/></button></div> : <div className="activity-layout"><section className="run-list">{state.history.map((run) => <button key={run.id} className={`run-card ${selectedRun?.id === run.id ? 'selected' : ''}`} onClick={() => setSelectedRun(run)}><span className={`run-icon ${run.status}`}>{run.status === 'completed' ? <CheckCircle2 size={21}/> : <AlertCircle size={21}/>}</span><div><strong>{run.directories.map(basename).join(', ')}</strong><small>{date(run.startedAt)}</small><span>{run.moved} moved · {run.errors} errors</span></div><span className="run-status">{run.status}</span></button>)}</section>
          <section className="run-detail">{selectedRun ? <><div className="section-heading"><h2>Move receipts</h2><span>{selectedRun.entries.length} recorded</span></div>{selectedRun.failure && <p className="error-copy">{selectedRun.failure}</p>}
            {selectedRun.entries.map((entry, i) => <div className={`receipt ${entry.ok ? '' : 'failed'}`} key={i}><FileIcon name={entry.from ?? entry.file}/><div><strong>{entry.from ?? entry.file}</strong><span>{entry.ok ? `→ ${entry.to}` : entry.error}</span><small>{entry.root}</small></div>{entry.ok ? <Check size={16}/> : <AlertCircle size={16}/>}</div>)}
            {desktop && selectedRun.directories.map((directory) => <button className="button secondary small" key={directory} onClick={() => revealDirectory(directory).catch((e) => notify(e.message))}><FolderOpen size={16}/>Open {basename(directory)}</button>)}</> : <div className="receipt-empty"><ArrowLeft size={27}/><p>Select an operation to see its real move receipts.</p></div>}</section></div>}
      </>}

      {page === 'settings' && preferences && <form onSubmit={(e) => { e.preventDefault(); savePreferences(); }} className="preferences-form">
        <section className="settings-card"><div className="settings-heading"><Layers3 size={23}/><div><h2>How your files find their place</h2><p>These settings apply to your next analysis. Your current review stays intact.</p></div></div>
          <div className="setting-row"><label htmlFor="embedding-model"><strong>Embedding model</strong><small>Turns filenames into vectors for comparison.</small></label><select id="embedding-model" value={preferences.embeddingModel} onChange={(e) => setPreferences({ ...preferences, embeddingModel: e.target.value })} disabled={locked}>{[...new Set([preferences.embeddingModel, ...(state?.models.filter((m) => m.local !== false && m.capabilities.includes('embedding')).map((m) => m.name) ?? [])])].map((name) => <option key={name}>{name}</option>)}</select></div>
          <div className="setting-row"><label htmlFor="naming-model"><strong>Folder-naming model</strong><small>Chooses a folder for each group.</small></label><select id="naming-model" value={preferences.model} onChange={(e) => setPreferences({ ...preferences, model: e.target.value })} disabled={locked}>{[...new Set([preferences.model, ...(state?.models.filter((m) => m.local !== false && m.capabilities.includes('completion')).map((m) => m.name) ?? [])])].map((name) => <option key={name}>{name}</option>)}</select></div>
          <div className="setting-row"><label htmlFor="threshold"><strong>Similarity threshold</strong><small>A higher value creates stricter, smaller groups. This is not a probability.</small></label><div className="range-control"><input id="threshold" type="range" min="0.3" max="0.95" step="0.01" value={preferences.threshold} onChange={(e) => setPreferences({ ...preferences, threshold: Number(e.target.value) })} disabled={locked}/><output>{preferences.threshold.toFixed(2)}</output></div></div>
          <div className="setting-row"><label htmlFor="folder-language"><strong>Suggested folder names</strong><small>The interface stays in English.</small></label><select aria-label="Suggested folder names" id="folder-language" value={preferences.folderLanguage} onChange={(e) => setPreferences({ ...preferences, folderLanguage: e.target.value })} disabled={locked}><option>French</option><option>English</option></select></div>
          <div className="setting-row"><label htmlFor="max-tokens"><strong>Response token limit</strong><small>Maximum per naming response. Invalid output is retried once.</small></label><input id="max-tokens" type="number" min="16" max="512" value={preferences.maxTokens} onChange={(e) => setPreferences({ ...preferences, maxTokens: Number(e.target.value) })} disabled={locked}/></div>
        </section><section className="settings-card local-storage"><ShieldCheck size={24}/><div><h2>Yours, and only on this device.</h2><p>Drafts, preferences, recent directories, logs and move receipts are saved locally.</p><code>{state?.dataDirectory}</code></div></section>
        <div className="settings-footer"><span>Existing subdirectories are never scanned recursively.</span><button type="submit" className="button primary" disabled={locked}><Check size={17}/>Save preferences</button></div>
      </form>}
      {(busy || logs.length > 0) && <LogPanel logs={page === 'activity' ? currentLogs : logs} busy={busy} download={download} moveProgress={moveProgress} expanded={page === 'activity'}/>}
      <footer className="page-footer"><span>Thoughtful organization. Entirely on your device.</span><span><ShieldCheck size={13}/>You approve every move.</span></footer>
    </main>
    {toast && <div className={`toast ${toast.kind}`} role="status">{toast.kind === 'success' ? <CheckCircle2 size={20}/> : <AlertCircle size={20}/>}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setToast(null)}><X size={17}/></button></div>}
    {modal === 'path' && <Modal title="Development directory picker" onClose={() => setModal(null)}><p>This browser development view uses the real Node.js engine. Enter an existing directory path. The desktop app uses the native Windows folder picker.</p><form onSubmit={(e) => { e.preventDefault(); if (input.trim()) { setSelected((old) => [...new Set([...old, input.trim()])]); setModal(null); } }}><label htmlFor="directory-path">Directory path</label><input id="directory-path" value={input} onChange={(e) => setInput(e.target.value)} placeholder="/path/to/a/real/directory" required/><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit">Add directory<Plus size={16}/></button></div></form></Modal>}
    {modal === 'folder' && <Modal title="Make a new home for your files" onClose={() => setModal(null)}><p>Add a destination inside {basename(root.path)}, then move files into it.</p><form onSubmit={async (e) => { e.preventDefault(); const ok = await edit({ action: 'add_group', rootId: root.id, name: input }); if (ok) setModal(null); }}><label htmlFor="new-folder">Folder name</label><input id="new-folder" value={input} onChange={(e) => setInput(e.target.value)} maxLength={80} placeholder="Give it a thoughtful name" required/><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit" disabled={editing}>Add folder<FolderPlus size={16}/></button></div></form></Modal>}
    {modal === 'approve' && <Modal title="Ready to give every file its place?" onClose={() => setModal(null)}><div className="approval-modal-icon"><ShieldCheck size={35}/></div><p>You’re approving <strong>{countFiles(plan)} files</strong> into <strong>{countFolders(plan)} folders</strong> across <strong>{plan.roots.length} source {plan.roots.length === 1 ? 'directory' : 'directories'}</strong>.</p><div className="approval-note"><Check size={18}/><span>Your edited plan is applied directly. Existing files are protected with automatic name suffixes.</span></div><div className="modal-actions"><button className="button secondary" onClick={() => setModal(null)}>Keep reviewing</button><button className="button primary" onClick={organize}>Organize {countFiles(plan)} files<ArrowRight size={17}/></button></div></Modal>}
    {modal === 'discard' && <Modal title="Discard this draft?" onClose={() => setModal(null)}><p>Your files will stay exactly where they are. You can create another proposal whenever you like.</p><div className="modal-actions"><button className="button secondary" onClick={() => setModal(null)}>Keep my draft</button><button className="button danger" onClick={async () => { try { await call('discard_plan', { planId: plan.id, revision: plan.revision }); setPlan(null); setModal(null); await refresh(); } catch (e) { notify(e.message); } }}>Discard draft</button></div></Modal>}
  </div>;
}
