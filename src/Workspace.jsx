import React, { useEffect, useRef, useState } from 'react';
import { Folder, FolderOpen, FolderPlus, FileText, Plus, X, Check, CheckCircle2, Cpu,
  Settings2, History, RefreshCw, Download, LoaderCircle, Trash2, Sun, Moon, ArrowLeft,
  ArrowRight, ShieldCheck, Layers3, GripVertical, AlertCircle, Keyboard, StopCircle, Zap } from 'lucide-react';
import { FileIcon, FolderCard, Modal, LogPanel } from './components.jsx';
import { call, connect, subscribe, desktop, chooseDirectories, revealDirectory, disconnect,
  configureApplicationShortcuts, saveApplicationSettings, openQuickAccess, setReviewLock, prepareShutdown } from './bridge.js';
import { shortcutFromEvent } from './shortcut.js';
import { createCloseController } from './closing.js';

const basename = (value) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
const bytes = (value = 0) => value >= 1e9 ? (value / 1e9).toFixed(1) + ' GB' : value >= 1e6 ? (value / 1e6).toFixed(0) + ' MB' : Math.ceil(value / 1e3) + ' KB';
const date = (value) => new Date(value).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
const countFiles = (plan) => plan?.roots.reduce((n, root) => n + root.groups.reduce((m, group) => m + group.files.length, 0), 0) ?? 0;
const countFolders = (plan) => plan?.roots.reduce((n, root) => n + root.groups.filter((group) => group.files.length).length, 0) ?? 0;
const statusLabel = (status) => ({ draft: 'Review needed', applying: 'In progress', completed: 'Completed', partial: 'Review needed', interrupted: 'Interrupted' })[status] ?? status;
const navigation = [['organize', FolderOpen, 'Organize'], ['models', Cpu, 'Models'], ['activity', History, 'Activity'], ['settings', Settings2, 'Settings']];

export default function Workspace() {
  const [page, setPage] = useState('organize'), [state, setState] = useState(null), [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState([]), [rootId, setRootId] = useState(null), [busy, setBusy] = useState(null);
  const [preferences, setPreferences] = useState(null), [logs, setLogs] = useState([]), [download, setDownload] = useState(null), [moveProgress, setMoveProgress] = useState(null);
  const [toast, setToast] = useState(null), [modal, setModal] = useState(null), [input, setInput] = useState(''), [modelName, setModelName] = useState('');
  const [modelToDelete, setModelToDelete] = useState(null), [selectedRun, setSelectedRun] = useState(null), [editing, setEditing] = useState(false);
  const [dirtyNames, setDirtyNames] = useState(new Set()), [cancelling, setCancelling] = useState(false);
  const [externalBusy, setExternalBusy] = useState(null);
  const [closing, setClosing] = useState(false);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('clean-folder-theme') === 'black' ? 'black' : 'white'; } catch { return 'white'; } });
  const busyRef = useRef(null), externalBusyRef = useRef(null), editLock = useRef(false), autoSetup = useRef(false);
  const closeController = useRef(null), closingRef = useRef(false), dirtyNamesRef = useRef(false);
  dirtyNamesRef.current = dirtyNames.size > 0;
  const notify = (message, kind = 'error') => setToast({ message, kind });
  const refresh = async () => {
    const next = await call('get_state'); setState(next); setPlan(next.currentPlan); setLogs(next.logs); setPreferences(next.settings); setTheme(next.settings.theme);
    externalBusyRef.current = next.operation; setExternalBusy(next.operation); return next;
  };
  const perform = async (name, fn) => {
    if (closingRef.current || busyRef.current || externalBusyRef.current) return; busyRef.current = name; setBusy(name); setDownload(null); setMoveProgress(null);
    try { return await fn(); } catch (error) { if (!closingRef.current) notify(error.message); return null; }
    finally { busyRef.current = null; setBusy(null); setCancelling(false); }
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === 'black' ? 'dark' : 'light';
    try { localStorage.setItem('clean-folder-theme', theme); } catch { /* Preference is also stored by the local engine. */ }
  }, [theme]);
  useEffect(() => {
    const unsubscribe = subscribe((event, data) => {
      if (event === 'log') setLogs((old) => [...old, data].slice(-3000));
      if (event === 'download') setDownload(data);
      if (event === 'move_progress') setMoveProgress(data);
      if (event === 'bridge_error') { externalBusyRef.current = null; setExternalBusy(null); notify(data); }
      if (event === 'operation') {
        externalBusyRef.current = data; setExternalBusy(data);
        if (!data && !busyRef.current && !closingRef.current) refresh().catch((error) => notify(error.message));
      }
      if (event === 'navigate' && navigation.some(([id]) => id === data)) { setPage(data); refresh().catch((error) => notify(error.message)); }
    });
    connect().then(refresh).then(async (next) => {
      try { await configureApplicationShortcuts(next.settings); }
      catch (error) { notify('Your saved shortcut is unavailable: ' + error.message); }
      if (!next.ready && !next.setup?.autoSetupDisabled && !autoSetup.current) {
        autoSetup.current = true; perform('setup', async () => { await call('setup_runtime'); await refresh(); });
      }
    }).catch((error) => notify(error.message));
    let removeClose, disposed = false;
    if (desktop) import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      closeController.current = createCloseController({
        isBusy: () => Boolean(busyRef.current || externalBusyRef.current || editLock.current || dirtyNamesRef.current),
        confirm: () => setModal('quit'),
        shutdown: async () => { closingRef.current = true; setClosing(true); await prepareShutdown(); },
        disconnect,
        destroy: () => window.destroy(),
        onError: (error) => { closingRef.current = false; setClosing(false); notify('Could not close Clean_folder: ' + error.message); },
      });
      const remove = await window.onCloseRequested(closeController.current.request);
      if (disposed) remove(); else removeClose = remove;
    }).catch((error) => notify('Could not register the close button: ' + error.message));
    const onMessage = (event) => {
      if (event.origin === location.origin && event.data?.type === 'clean-folder-navigate' && navigation.some(([id]) => id === event.data.page)) {
        setPage(event.data.page); refresh().catch((error) => notify(error.message));
      }
    };
    window.addEventListener('message', onMessage);
    return () => { disposed = true; unsubscribe(); removeClose?.(); window.removeEventListener('message', onMessage); };
  }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(null), 6500); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => { setReviewLock(editing || dirtyNames.size > 0); }, [editing, dirtyNames]);
  const choose = async () => {
    try { const result = await chooseDirectories();
      if (result === null) { setInput(''); setModal('path'); }
      else setSelected((old) => [...new Set([...old, ...result])]);
    } catch (error) { notify(error.message); }
  };
  const analyze = () => perform('analysis', async () => {
    const next = await call('create_plan', { directories: selected });
    if (next.cancelled) { await refresh(); notify('Plan creation cancelled. Your files stayed in place.', 'info'); return; }
    setPlan(next); setRootId(next.roots[0]?.id); await refresh();
  });
  const cancelAnalysis = async () => {
    if (cancelling) return; setCancelling(true);
    try { const result = await call('cancel_analysis'); if (!result.cancelled) notify('The plan has just finished.', 'info'); }
    catch (error) { setCancelling(false); notify(error.message); }
  };
  const edit = async (change) => {
    if (editLock.current || busyRef.current) return false; editLock.current = true; setEditing(true);
    try { setPlan(await call('edit_plan', { planId: plan.id, revision: plan.revision, ...change })); return true; }
    catch (error) { notify(error.message); return false; }
    finally { editLock.current = false; setEditing(false); }
  };
  const onDirty = (id, dirty) => setDirtyNames((old) => { const next = new Set(old); dirty ? next.add(id) : next.delete(id); return next; });
  const organize = () => { setModal(null); return perform('organizing', async () => {
    const result = await call('apply_plan', { planId: plan.id, revision: plan.revision }); await refresh();
    notify(result.run.moved + ' files organized' + (result.run.errors ? '. Check Activity for any errors.' : '.'), result.run.errors ? 'info' : 'success');
  }); };
  const savePreferences = (next = preferences) => perform('preferences', async () => {
    await saveApplicationSettings(next, state.settings); await refresh(); notify('Settings saved.', 'success');
  });
  const changeTheme = (next) => perform('preferences', async () => {
    const previous = theme; setTheme(next);
    try { await call('save_settings', { settings: { theme: next } });
      setState((old) => ({ ...old, settings: { ...old.settings, theme: next } }));
      setPreferences((old) => ({ ...old, theme: next }));
    } catch (error) { setTheme(previous); throw error; }
  });
  const install = (event) => { event.preventDefault(); return perform('download', async () => {
    await call('install_model', { name: modelName.trim() }); setModelName(''); await refresh(); notify('Model installed.', 'success');
  }); };
  const removeModel = () => perform('deleting model', async () => {
    await call('delete_model', { name: modelToDelete.name }); setModal(null); setModelToDelete(null);
    const next = await refresh(); notify(next.ready ? 'Model deleted.' : 'Model deleted. Choose a replacement model before organizing files.', next.ready ? 'success' : 'info');
  });
  const root = plan?.roots.find((item) => item.id === rootId) ?? plan?.roots[0];
  const active = busy || externalBusy;
  const locked = closing || Boolean(active) || editing, draft = plan?.status === 'draft';
  const titles = { organize: plan ? 'Review your plan' : 'Organize files', models: 'Models', activity: 'Activity', settings: 'Settings' };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-icon" src="/logo.svg" alt=""/><div>Clean_folder<small>File organization</small></div></div>
      <nav aria-label="Main navigation">{navigation.map(([id, Icon, label]) => <button key={id} className={page === id ? 'active' : ''} aria-label={label} title={label} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><span className="nav-icon"><Icon size={23}/></span><span>{label}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className={'runtime-pill ' + (state?.ready ? 'ready' : '')}><span className="status-dot"/><span>{state?.ready ? 'Ready to organize' : busy === 'setup' ? 'Preparing…' : 'Engine unavailable'}</span></div><small>Processed on this computer</small></div>
    </aside>
    <main className="main-content" id="main-content">
      <header className="page-header"><span>{navigation.find(([id]) => id === page)[2]}</span><div className="header-actions"><button className="button secondary quick-launch" onClick={() => openQuickAccess().catch((error) => notify(error.message))}><Zap size={18}/>Quick access</button><button className="button secondary theme-toggle" disabled={!state || locked} aria-label={theme === 'white' ? 'Switch to dark mode' : 'Switch to light mode'} onClick={() => changeTheme(theme === 'white' ? 'black' : 'white')}>{theme === 'white' ? <Moon size={19}/> : <Sun size={19}/>}<span>{theme === 'white' ? 'Dark mode' : 'Light mode'}</span></button></div></header>
      <section className="page-title"><div><h1>{titles[page]}</h1><p>{page === 'organize' ? plan ? 'Check the proposed folders before moving your files.' : 'Choose a folder. Review the plan. Organize your files.' : page === 'models' ? 'Models use file clues to suggest suitable folders.' : page === 'activity' ? 'See which files were moved and review any errors.' : 'Adjust the appearance and file organization to suit your needs.'}</p></div>
        {page === 'models' && <button className="button secondary" disabled={locked} onClick={() => perform('refresh', refresh)}><RefreshCw size={18}/>Refresh</button>}
      </section>
      {!state && <section className="connection-card"><LoaderCircle className="spin" size={24}/><div><h2>Connecting to the local engine</h2><p>No files are being moved.</p></div><button className="button secondary" onClick={() => perform('connection', refresh)} disabled={locked}>Retry</button></section>}
      {state && !state.ready && <section className="setup-card"><Download size={26}/><div><h2>{busy === 'setup' ? 'Preparing models' : 'Models are unavailable'}</h2><p>{busy === 'setup' ? 'Setup is running. You can organize files once the models are ready.' : 'Check the selected models, or run setup again.'}</p>{download && <p>{download.model ?? 'Ollama'} · {download.status}{Number.isFinite(download.percent) ? ' · ' + download.percent + '%' : ''}</p>}{state.setup?.error && <p className="error-copy">{state.setup.error}</p>}</div><button className="button secondary" disabled={locked} onClick={() => perform('setup', async () => { await call('setup_runtime'); await refresh(); })}>Set up models</button></section>}
      {active === 'analysis' && <section className="analysis-card" role="status"><LoaderCircle size={28} className="spin"/><div><h2>{cancelling ? 'Cancelling…' : 'Creating your plan'}</h2><p>Finding suitable folders. Your files stay in place.</p></div><button className="button secondary" disabled={cancelling} onClick={cancelAnalysis}><StopCircle size={19}/>{cancelling ? 'Cancelling…' : 'Cancel plan creation'}</button></section>}

      {page === 'organize' && (!plan ? <>
        <ol className="steps"><li className="current"><span>1</span>Choose</li><li><span>2</span>Review</li><li><span>3</span>Organize</li></ol>
        {!selected.length ? <section className="empty-workspace"><span className="empty-icon"><FolderOpen size={44}/></span><h2>Which folder would you like to organize?</h2><p>Only files directly inside the folder will be organized.<br/>You can change the plan before applying it.</p><button className="button primary" onClick={choose} disabled={locked}><FolderPlus size={20}/>Choose folders</button></section> : <section className="selected-panel"><div className="section-heading"><h2>Folders to organize</h2><span>{selected.length} selected</span></div><div className="directory-list">{selected.map((directory) => <div className="directory-row" key={directory}><span className="directory-icon"><Folder size={25}/></span><div><h3>{basename(directory)}</h3><p title={directory}>{directory}</p></div><button className="icon-button" disabled={locked} aria-label={'Remove ' + basename(directory)} onClick={() => setSelected((old) => old.filter((item) => item !== directory))}><X size={19}/></button></div>)}</div><div className="selected-actions"><button className="button secondary" onClick={choose} disabled={locked}><Plus size={19}/>Add a folder</button><button className="button primary" onClick={analyze} disabled={locked || !state?.ready}><Layers3 size={19}/>Create plan<ArrowRight size={18}/></button></div></section>}
        {Boolean(state?.recentDirectories.length) && <section className="recent-section"><div className="section-heading"><h2>Recent folders</h2></div><div className="recent-grid">{state.recentDirectories.slice(0, 6).map((directory) => <button className="recent-card" key={directory} disabled={locked} onClick={() => setSelected((old) => [...new Set([...old, directory])])}><Folder size={23}/><span><strong>{basename(directory)}</strong><small>{directory}</small></span><Plus size={18}/></button>)}</div></section>}
      </> : <>
        <div className="review-summary"><span><FileText size={22}/><strong>{countFiles(plan)}</strong> files</span><span><Folder size={22}/><strong>{countFolders(plan)}</strong> folders</span><span className="plan-status">{statusLabel(plan.status)}</span></div>
        <div className="review-toolbar"><div className="root-tabs" role="tablist" aria-label="Source folders">{plan.roots.map((item) => <button role="tab" aria-selected={root?.id === item.id} key={item.id} onClick={() => setRootId(item.id)} title={item.path}><Folder size={18}/>{basename(item.path)}</button>)}</div>{draft && <button className="button secondary small" disabled={locked} onClick={() => { setInput(''); setModal('folder'); }}><Plus size={18}/>New folder</button>}</div>
        <div className="source-path"><FolderOpen size={17}/><span>{root?.path}</span></div>
        {draft && <p className="review-tip"><GripVertical size={19}/>Move files between folders. Use the pencil to rename a folder.</p>}
        {root?.content && <p className="content-note"><FileText size={17}/>{root.content.read} files have content clues. Other files are grouped by name.</p>}
        {root && <div className="folder-grid">{root.groups.filter((group) => draft || group.files.length).map((group) => <FolderCard key={group.id} group={group} root={root} editable={draft} busy={locked} edit={edit} error={notify} onDirty={onDirty}/>)}</div>}
        {!countFiles(plan) && <div className="small-empty"><FolderOpen size={34}/><h2>No files to organize</h2><p>Subfolders are not scanned.</p></div>}
        {draft ? <div className="approval-bar"><span><ShieldCheck size={20}/>{dirtyNames.size ? 'Save folder names before continuing.' : 'Files will only move after you confirm.'}</span><div className="approval-actions"><button className="button secondary" disabled={locked} onClick={() => setModal('discard')}>Discard plan</button><button className="button primary" disabled={locked || dirtyNames.size > 0 || !countFiles(plan)} onClick={() => setModal('approve')}><Check size={20}/>Organize files</button></div></div> : <div className="completion-panel"><CheckCircle2 size={28}/><div><h2>{plan.status === 'completed' ? 'Organization complete' : 'Review the result'}</h2><p>File moves are saved in Activity.</p></div><button className="button secondary" onClick={() => setPage('activity')}>View activity</button><button className="button primary" disabled={locked} onClick={() => perform('archive', async () => { await call('archive_plan'); setSelected([]); await refresh(); })}>Start again</button></div>}
      </>)}

      {page === 'models' && <><section className="model-install"><div><h2>Install a model</h2><p>Enter its name from the Ollama model library.</p></div><form onSubmit={install}><label className="sr-only" htmlFor="model-name">Ollama model name</label><input id="model-name" placeholder="e.g. llama3.2:1b" value={modelName} onChange={(event) => setModelName(event.target.value)} disabled={locked}/><button className="button primary" disabled={locked || !modelName.trim() || !state?.connected}><Download size={18}/>Install model</button></form></section>
        {busy === 'download' && <section className="download-card"><LoaderCircle className="spin" size={24}/><div><strong>{download?.model ?? modelName}</strong><p>{download?.status ?? 'Downloading…'}{Number.isFinite(download?.percent) ? ' · ' + download.percent + '%' : ''}</p></div><button className="button secondary" onClick={() => call('cancel_download').catch((error) => notify(error.message))}>Cancel download</button></section>}
        <div className="section-heading"><h2>Installed models</h2><span>{state?.models.length ?? 0}</span></div><div className="models-grid">{state?.models.map((model) => <article className="model-card" key={model.name}><div className="model-top"><span className="model-icon"><Cpu size={27}/></span><span>{bytes(model.size)}</span></div><h3>{model.name}</h3><p>{model.local === false ? 'Remote model, not used' : model.capabilities.includes('embedding') ? 'Compares the meaning of files' : model.capabilities.includes('completion') ? 'Suggests folder names' : 'Capabilities unavailable'}</p><div className="model-buttons">
          {model.local !== false && model.capabilities.includes('embedding') && <button className={'button small ' + (state.settings.embeddingModel === model.name ? 'chosen' : 'secondary')} disabled={locked || state.settings.embeddingModel === model.name} onClick={() => savePreferences({ ...state.settings, embeddingModel: model.name })}><Layers3 size={17}/>{state.settings.embeddingModel === model.name ? 'Selected for comparison' : 'Use for comparison'}</button>}
          {model.local !== false && model.capabilities.includes('completion') && <button className={'button small ' + (state.settings.model === model.name ? 'chosen' : 'secondary')} disabled={locked || state.settings.model === model.name} onClick={() => savePreferences({ ...state.settings, model: model.name })}><Check size={17}/>{state.settings.model === model.name ? 'Selected for naming' : 'Use for naming'}</button>}
          <button className="button secondary small" aria-label={'Delete ' + model.name} disabled={locked || !state.connected} onClick={() => { setModelToDelete(model); setModal('delete-model'); }}><Trash2 size={17}/>Delete</button>
        </div></article>)}</div>{!state?.models.length && <div className="small-empty"><Cpu size={32}/><h2>No models installed</h2><p>Install a model or run setup again.</p></div>}</>}

      {page === 'activity' && (!state?.history.length ? <div className="small-empty large"><History size={40}/><h2>No activity yet</h2><p>File moves will appear here.</p></div> : <div className="activity-layout"><section className="run-list">{state.history.map((run) => <button key={run.id} className={'run-card ' + (selectedRun?.id === run.id ? 'selected' : '')} onClick={() => setSelectedRun(run)}><History size={23}/><span><strong>{run.directories.map(basename).join(', ')}</strong><small>{date(run.startedAt)}</small><span>{run.moved} moved · {run.errors} errors</span></span><span className="run-status">{statusLabel(run.status)}</span></button>)}</section><section className="run-detail">{selectedRun ? <><div className="section-heading"><h2>Move receipts</h2><span>{selectedRun.entries.length}</span></div>{selectedRun.failure && <p className="error-copy">{selectedRun.failure}</p>}{selectedRun.entries.map((entry, index) => <div className={'receipt ' + (entry.ok ? '' : 'failed')} key={index}><FileIcon name={entry.from ?? entry.file}/><div><strong>{entry.from ?? entry.file}</strong><span>{entry.ok ? '→ ' + entry.to : entry.error}</span><small>{entry.root}</small></div>{entry.ok ? <Check size={18}/> : <AlertCircle size={18}/>}</div>)}{desktop && selectedRun.directories.map((directory) => <button className="button secondary small" key={directory} onClick={() => revealDirectory(directory).catch((error) => notify(error.message))}><FolderOpen size={18}/>Open {basename(directory)}</button>)}</> : <div className="receipt-empty"><ArrowLeft size={25}/><p>Select an operation to see its file moves.</p></div>}</section></div>)}

      {page === 'settings' && preferences && <form className="preferences-form" onSubmit={(event) => { event.preventDefault(); savePreferences(); }}>
        <section className="settings-card"><div className="settings-heading"><FileText size={25}/><div><h2>Document content</h2><p>Use content clues to organize files with unclear names.</p></div></div><label className="setting-row checkbox-row"><span><strong>Use a short document excerpt</strong><small>Up to 80 words from text, PDF and Word (.docx) files, processed on this computer. Excerpts are not saved.</small></span><input type="checkbox" checked={preferences.inspectContent} disabled={locked} onChange={(event) => setPreferences({ ...preferences, inspectContent: event.target.checked })}/></label><p className="quiet">Scanned PDFs, protected documents and unsupported formats are grouped by filename.</p><div className="setting-row"><label htmlFor="folder-language"><strong>Folder name language</strong></label><select id="folder-language" aria-label="Folder name language" disabled={locked} value={preferences.folderLanguage} onChange={(event) => setPreferences({ ...preferences, folderLanguage: event.target.value })}><option value="French">French</option><option value="English">English</option></select></div></section>
        <section className="settings-card"><div className="settings-heading"><Keyboard size={25}/><div><h2>Show or hide the window</h2><p>The shortcut works even while another app has focus.</p></div></div><div className="setting-row"><label htmlFor="visibility-shortcut"><strong>Window shortcut</strong><small>Click the field, then press Ctrl, Alt or Windows with another key.</small></label><div className="shortcut-control"><input id="visibility-shortcut" aria-label="Window shortcut" readOnly value={preferences.visibilityShortcut} placeholder="Press a key combination" disabled={locked} onKeyDown={(event) => {
          if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
          if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) { event.currentTarget.blur(); return; }
          event.preventDefault(); try { const shortcut = shortcutFromEvent(event); if (shortcut) setPreferences({ ...preferences, visibilityShortcut: shortcut }); } catch { notify('Use Ctrl, Alt or Windows with a letter, number or function key.'); }
        }}/><button type="button" className="button secondary small" disabled={locked || !preferences.visibilityShortcut} onClick={() => setPreferences({ ...preferences, visibilityShortcut: '' })}>Clear</button></div></div></section>
        <section className="settings-card"><div className="settings-heading"><Zap size={25}/><div><h2>Quick access</h2><p>A small window to choose a folder and confirm its organization.</p></div></div><div className="setting-row"><label htmlFor="quick-shortcut"><strong>Quick access shortcut</strong><small>Default: Ctrl + Alt + Space. Works even when the main window is hidden.</small></label><div className="shortcut-control"><input id="quick-shortcut" aria-label="Quick access shortcut" readOnly value={preferences.quickAccessShortcut} placeholder="Press a key combination" disabled={locked} onKeyDown={(event) => {
          if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
          if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) { event.currentTarget.blur(); return; }
          event.preventDefault(); try { const shortcut = shortcutFromEvent(event); if (shortcut) setPreferences({ ...preferences, quickAccessShortcut: shortcut }); } catch { notify('Use Ctrl, Alt or Windows with another key.'); }
        }}/><button type="button" className="button secondary small" disabled={locked || !preferences.quickAccessShortcut} onClick={() => setPreferences({ ...preferences, quickAccessShortcut: '' })}>Disable quick shortcut</button></div></div></section>
        <details className="settings-card advanced-settings"><summary><Settings2 size={23}/>Advanced settings<Chevron/></summary><p className="quiet">These settings apply to your next plan.</p><div className="setting-row"><label htmlFor="embedding-model"><strong>Comparison model</strong></label><select id="embedding-model" value={preferences.embeddingModel} disabled={locked} onChange={(event) => setPreferences({ ...preferences, embeddingModel: event.target.value })}>{[...new Set([preferences.embeddingModel, ...(state.models.filter((model) => model.local !== false && model.capabilities.includes('embedding')).map((model) => model.name))])].map((name) => <option key={name}>{name}</option>)}</select></div><div className="setting-row"><label htmlFor="naming-model"><strong>Folder naming model</strong></label><select id="naming-model" value={preferences.model} disabled={locked} onChange={(event) => setPreferences({ ...preferences, model: event.target.value })}>{[...new Set([preferences.model, ...state.models.filter((model) => model.local !== false && model.capabilities.includes('completion')).map((model) => model.name)])].map((name) => <option key={name}>{name}</option>)}</select></div><div className="setting-row"><label htmlFor="threshold"><strong>Grouping precision</strong><small>A higher value separates files into more groups.</small></label><div className="range-control"><input id="threshold" type="range" min="0.3" max="0.95" step="0.01" disabled={locked} value={preferences.threshold} onChange={(event) => setPreferences({ ...preferences, threshold: Number(event.target.value) })}/><output>{preferences.threshold.toFixed(2)}</output></div></div><div className="setting-row"><label htmlFor="max-tokens"><strong>Response length limit</strong></label><input id="max-tokens" type="number" min="16" max="512" disabled={locked} value={preferences.maxTokens} onChange={(event) => setPreferences({ ...preferences, maxTokens: Number(event.target.value) })}/></div></details>
        <div className="settings-footer"><span>Your settings are saved on this computer.</span><button type="submit" className="button primary" disabled={locked}><Check size={19}/>Save settings</button></div>
      </form>}
      {(active || logs.length > 0) && <LogPanel logs={page === 'activity' && selectedRun ? logs.filter((entry) => entry.runId === selectedRun.id) : logs} busy={active} download={download} moveProgress={moveProgress}/>}
      <footer className="page-footer"><ShieldCheck size={16}/>Your files stay on this computer.</footer>
    </main>
    {toast && <div className={'toast ' + toast.kind} role="status">{toast.kind === 'success' ? <CheckCircle2 size={22}/> : <AlertCircle size={22}/>}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setToast(null)}><X size={19}/></button></div>}
    {modal === 'path' && <Modal title="Choose a folder" onClose={() => setModal(null)}><p>Enter the path of the folder to organize.</p><form onSubmit={(event) => { event.preventDefault(); if (input.trim()) { setSelected((old) => [...new Set([...old, input.trim()])]); setModal(null); } }}><label htmlFor="directory-path">Folder path</label><input id="directory-path" value={input} onChange={(event) => setInput(event.target.value)} required/><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit">Add folder</button></div></form></Modal>}
    {modal === 'folder' && <Modal title="Add a folder to the plan" onClose={() => setModal(null)}><p>This folder will be created when you organize the files.</p><form onSubmit={async (event) => { event.preventDefault(); if (await edit({ action: 'add_group', rootId: root.id, name: input })) setModal(null); }}><label htmlFor="new-folder">Folder name</label><input id="new-folder" value={input} onChange={(event) => setInput(event.target.value)} maxLength={80} required/><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setModal(null)}>Cancel</button><button className="button primary" disabled={editing} type="submit">Add folder</button></div></form></Modal>}
    {modal === 'approve' && <Modal title="Organize these files?" onClose={() => setModal(null)}><p><strong>{countFiles(plan)} files</strong> will move into <strong>{countFolders(plan)} folders</strong>, following the plan you reviewed.</p><p>Existing files will not be overwritten.</p><div className="modal-actions"><button className="button secondary" onClick={() => setModal(null)}>Keep reviewing</button><button className="button primary" onClick={organize}>Organize {countFiles(plan)} files</button></div></Modal>}
    {modal === 'discard' && <Modal title="Discard this plan?" onClose={() => setModal(null)}><p>Your files will stay in place.</p><div className="modal-actions"><button className="button secondary" onClick={() => setModal(null)}>Keep plan</button><button className="button danger" onClick={() => perform('discard', async () => { await call('discard_plan', { planId: plan.id, revision: plan.revision }); setModal(null); await refresh(); })}>Discard plan</button></div></Modal>}
    {modal === 'delete-model' && modelToDelete && <Modal title="Delete this model?" onClose={() => setModal(null)}><p><strong>{modelToDelete.name}</strong> will be removed from Ollama. Other apps will no longer be able to use it.</p><p>If this model is selected, another compatible model will be used if available.</p><div className="modal-actions"><button className="button secondary" disabled={locked} onClick={() => setModal(null)}>Cancel</button><button className="button danger" disabled={locked} onClick={removeModel}><Trash2 size={18}/>Delete model</button></div></Modal>}
    {modal === 'quit' && <Modal title="Quit Clean_folder?" onClose={() => { if (!closing) setModal(null); }}><p>{active ? 'The current operation will stop before Clean_folder closes. Files already moved will stay in their new folders.' : 'Unsaved folder-name edits will be discarded. Your saved plan will remain available.'}</p>{closing && <p role="status">Stopping the operation and saving your activity…</p>}<div className="modal-actions"><button className="button secondary" disabled={closing} onClick={() => setModal(null)}>Keep open</button><button className="button danger" disabled={closing} onClick={() => closeController.current?.quit()}>{closing ? 'Quitting…' : 'Quit'}</button></div></Modal>}
  </div>;
}
function Chevron() { return <span aria-hidden="true" className="details-chevron">⌄</span>; }
