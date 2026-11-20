import React, { useEffect, useRef, useState } from 'react';
import { Folder, FolderOpen, FolderPlus, ArrowRight, X, Check, CheckCircle2,
  LoaderCircle, Zap, StopCircle, AlertCircle, History, Keyboard } from 'lucide-react';
import { call, connect, subscribe, desktop, chooseDirectories, hideQuickAccess, openMainWorkspace } from './bridge.js';

const basename = (value) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
const countFiles = (plan) => plan?.roots.reduce((total, root) => total + root.groups.reduce((n, group) => n + group.files.length, 0), 0) ?? 0;
const fileLabel = (count) => count === 1 ? 'file' : 'files';
const shortcutLabel = (value) => value?.replaceAll('Control', 'Ctrl').replaceAll('Super', 'Windows').replaceAll('+', ' + ');

export default function QuickAccess() {
  const [state, setState] = useState(null), [plan, setPlan] = useState(null), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(null), [operation, setOperation] = useState(null), [error, setError] = useState(null);
  const [result, setResult] = useState(null), [progress, setProgress] = useState(null), [cancelling, setCancelling] = useState(false);
  const [showPath, setShowPath] = useState(false), [pathInput, setPathInput] = useState(''), [message, setMessage] = useState(null);
  const busyRef = useRef(null), operationRef = useRef(null), ownedPlan = useRef(null), refreshing = useRef(null);
  const acceptState = (next) => {
    setState(next); operationRef.current = next.operation; setOperation(next.operation);
    document.documentElement.dataset.theme = next.settings.theme;
    document.documentElement.style.colorScheme = next.settings.theme === 'black' ? 'dark' : 'light';
    if (ownedPlan.current === next.currentPlan?.id) setPlan(next.currentPlan);
    else if (ownedPlan.current && !busyRef.current) { ownedPlan.current = null; setPlan(null); }
    return next;
  };
  const refresh = () => {
    if (!refreshing.current) refreshing.current = call('get_state').then(acceptState).finally(() => { refreshing.current = null; });
    return refreshing.current;
  };
  useEffect(() => {
    try {
      const theme = localStorage.getItem('clean-folder-theme') === 'black' ? 'black' : 'white';
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme === 'black' ? 'dark' : 'light';
    } catch { /* The engine supplies the theme as soon as the connection is ready. */ }
    const unsubscribe = subscribe((event, data) => {
      if (event === 'operation') {
        operationRef.current = data; setOperation(data);
        if (!data) refresh().catch((error) => setError(error.message));
      }
      if (event === 'move_progress') setProgress(data);
      if (event === 'settings') {
        document.documentElement.dataset.theme = data.theme;
        document.documentElement.style.colorScheme = data.theme === 'black' ? 'dark' : 'light';
        refresh().catch((error) => setError(error.message));
      }
      if (event === 'bridge_error') {
        setError(data); setBusy(null); busyRef.current = null; operationRef.current = null; setOperation(null);
        setState((old) => old ? { ...old, ready: false, connected: false } : old);
      }
      if (event === 'shutdown') { setOperation('closing'); operationRef.current = 'closing'; setState((old) => old ? { ...old, ready: false } : old); }
    });
    connect().then(refresh).catch((error) => setError(error.message));
    const focus = () => refresh().catch((error) => setError(error.message));
    const keydown = (event) => { if (event.key === 'Escape') hideQuickAccess().catch((error) => setError(error.message)); };
    window.addEventListener('focus', focus); window.addEventListener('keydown', keydown);
    let removeFocus, disposed = false;
    if (desktop) import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const remove = await getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) focus(); });
      if (disposed) remove(); else removeFocus = remove;
    });
    return () => { disposed = true; unsubscribe(); removeFocus?.(); window.removeEventListener('focus', focus); window.removeEventListener('keydown', keydown); };
  }, []);
  const prepare = async (directory) => {
    if (busyRef.current || operationRef.current) return;
    busyRef.current = 'checking'; setBusy('checking'); setError(null); setResult(null); setMessage(null); setProgress(null);
    try {
      const latest = acceptState(await call('get_state'));
      if (latest.operation) throw new Error('An operation is already running. Wait until it finishes.');
      if (!latest.ready) throw new Error('Set up or select your models in Clean_folder.');
      if (latest.currentPlan?.status === 'draft') {
        if (latest.currentPlan.id !== ownedPlan.current) throw new Error('A plan is already open in Clean_folder. Review it before starting another operation.');
        await call('discard_plan', { planId: latest.currentPlan.id, revision: latest.currentPlan.revision });
      }
      ownedPlan.current = null; setPlan(null); setSelected(directory); setShowPath(false);
      busyRef.current = 'analysis'; setBusy('analysis');
      const next = await call('create_plan', { directories: [directory] });
      if (next.cancelled) { setMessage('Plan creation cancelled. Your files stayed in place.'); return; }
      ownedPlan.current = next.id; setPlan(next);
    } catch (error) { setError(error.message); }
    finally { busyRef.current = null; setBusy(null); setCancelling(false); refresh().catch((error) => setError(error.message)); }
  };
  const choose = async () => {
    setError(null);
    try {
      const directories = await chooseDirectories({ multiple: false });
      if (directories === null) { setPathInput(''); setShowPath(true); }
      else if (directories[0]) await prepare(directories[0]);
    } catch (error) { setError(error.message); }
  };
  const apply = async () => {
    if (busyRef.current || operationRef.current || !plan || plan.id !== ownedPlan.current) return;
    busyRef.current = 'organizing'; setBusy('organizing'); setError(null); setProgress(null);
    try {
      const next = await call('apply_plan', { planId: plan.id, revision: plan.revision });
      setPlan(next.plan); setResult(next.run);
    } catch (error) { setError(error.message); }
    finally { busyRef.current = null; setBusy(null); refresh().catch((error) => setError(error.message)); }
  };
  const cancel = async () => {
    setCancelling(true);
    try { const next = await call('cancel_analysis'); if (!next.cancelled) setCancelling(false); }
    catch (error) { setError(error.message); setCancelling(false); }
  };
  const openFull = async (page = 'organize') => {
    try { await openMainWorkspace(page); await hideQuickAccess(); }
    catch (error) { setError(error.message); }
  };
  const active = operation === 'closing' ? 'closing' : busy || operation;
  const blocked = state?.currentPlan?.status === 'draft' && state.currentPlan.id !== ownedPlan.current;
  const draft = plan?.status === 'draft';
  const groups = plan?.roots.flatMap((root) => root.groups.filter((group) => group.files.length)) ?? [];

  return <div className="quick-shell">
    <header className="quick-header"><img src="/logo.svg" alt=""/><div><strong>Quick access</strong><small>Clean_folder</small></div><button className="icon-button" aria-label="Close quick access" onClick={() => hideQuickAccess().catch((error) => setError(error.message))}><X size={19}/></button></header>
    <main className="quick-body">
      <div className="quick-title"><span><Zap size={21}/></span><div><h1>Organize a folder</h1><p>Choose a folder, then confirm.</p></div></div>
      {error && <div className="quick-notice error-copy" role="alert"><AlertCircle size={18}/><span>{error}</span></div>}
      {!state && <p className="quick-loading" role="status"><LoaderCircle className="spin" size={18}/>Connecting to the local engine…</p>}
      {state && !state.ready && <div className="quick-notice"><CpuNotice/><span>Models are not ready.</span><button className="button secondary small" onClick={() => openFull('models')}>Open models</button></div>}
      {blocked && !active && <div className="quick-existing"><FolderOpen size={25}/><h2>A plan is already open</h2><p>Review your existing plan in the main window.</p><button className="button secondary" onClick={() => openFull()}>Open plan<ArrowRight size={17}/></button></div>}
      {!blocked && <>
        <button className={'quick-picker ' + (selected ? 'has-folder' : '')} disabled={!state?.ready || Boolean(active)} onClick={choose}><span className="quick-folder-icon"><FolderPlus size={30}/></span><span><strong>{selected ? basename(selected) : 'Choose a folder'}</strong><small>{selected ? 'Change folder' : 'Files in this folder only'}</small></span><ArrowRight size={19}/></button>
        {selected && <p className="quick-path" title={selected}>{selected}</p>}
        {showPath && <form className="quick-path-form" onSubmit={(event) => { event.preventDefault(); if (pathInput.trim()) prepare(pathInput.trim()); }}><label htmlFor="quick-directory">Folder path</label><input id="quick-directory" value={pathInput} onChange={(event) => setPathInput(event.target.value)} autoFocus required/><button className="button primary" disabled={Boolean(active)} type="submit">Prepare folder<ArrowRight size={17}/></button></form>}
        {!plan && !result && !active && !showPath && Boolean(state?.recentDirectories.length) && <section className="quick-recents"><h2><History size={16}/>Recent folders</h2>{state.recentDirectories.slice(0, 3).map((directory) => <button key={directory} onClick={() => prepare(directory)} disabled={!state.ready} title={directory}><Folder size={20}/><span><strong>{basename(directory)}</strong><small>{directory}</small></span><ArrowRight size={16}/></button>)}</section>}
      </>}
      {active && <section className="quick-progress" role="status"><LoaderCircle size={28} className="spin"/><h2>{active === 'closing' ? 'Closing Clean_folder' : active === 'analysis' ? cancelling ? 'Cancelling…' : 'Preparing your plan' : active === 'organizing' ? 'Organizing files' : 'Checking folder'}</h2><p>{active === 'closing' ? 'Stopping the operation and saving your activity…' : active === 'organizing' ? progress ? progress.completed + ' / ' + progress.total + ' files processed' : 'Moving files according to the plan.' : 'Your files stay in place.'}</p>{active === 'analysis' && <button className="button secondary small" onClick={cancel} disabled={cancelling}><StopCircle size={17}/>Cancel plan creation</button>}</section>}
      {message && !active && <p className="quick-message" role="status">{message}</p>}
      {draft && !active && <section className="quick-review"><div className="quick-review-heading"><h2>Plan ready</h2><span>{countFiles(plan)} {fileLabel(countFiles(plan))}</span></div><div className="quick-groups">{groups.map((group) => <div key={group.id}><span><Folder size={19}/></span><strong>{group.folder}</strong><small>{group.files.length} {fileLabel(group.files.length)}</small></div>)}</div>{!groups.length && <p>No files to organize in this folder.</p>}<p className="quick-confirm-note">Files will move into these folders after you confirm.</p><button className="button primary quick-apply" disabled={!countFiles(plan)} onClick={apply}><Check size={19}/>Organize {countFiles(plan)} {fileLabel(countFiles(plan))}</button><button className="quick-text-button" onClick={() => openFull()}>Edit the plan in Clean_folder<ArrowRight size={15}/></button></section>}
      {result && !active && <section className="quick-done"><span><CheckCircle2 size={33}/></span><h2>{result.errors ? 'Review the result' : 'Organization complete'}</h2><p>{result.moved} {fileLabel(result.moved)} organized{result.errors ? ' · ' + result.errors + ' errors' : '.'}</p><button className="button secondary" onClick={choose}>Choose another folder<FolderPlus size={18}/></button></section>}
    </main>
    <footer className="quick-footer"><button className="quick-text-button" onClick={() => openFull(result ? 'activity' : 'organize')}>Open Clean_folder<ArrowRight size={15}/></button>{state?.settings.quickAccessShortcut && <span className="quick-key"><Keyboard size={14}/>{shortcutLabel(state.settings.quickAccessShortcut)}</span>}</footer>
  </div>;
}
function CpuNotice() { return <AlertCircle size={19}/>; }
