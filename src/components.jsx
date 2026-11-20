import React, { useState, useEffect, useRef } from 'react';
import { englishLogMessage } from './log-language.js';
import { Folder, FolderOpen, FolderPlus, ArrowRight, ArrowUpRight, Check, CheckCircle2, X,
  Plus, Settings2, Layers3, History, ShieldCheck, HardDrive, Download, RefreshCw, LoaderCircle,
  File, FileText, FileImage, FileVideo, FileAudio, FileArchive, FileCode, FileSpreadsheet,
  ChevronDown, Pencil, GripVertical, AlertCircle, Terminal, Circle, Cpu, ArrowLeft, Trash2 } from 'lucide-react';
const bytes = (n = 0) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`;
const countFiles = (p) => p?.roots.reduce((n, r) => n + r.groups.reduce((m, g) => m + g.files.length, 0), 0) ?? 0;
const countFolders = (p) => p?.roots.reduce((n, r) => n + r.groups.filter((g) => g.files.length).length, 0) ?? 0;
export function FileIcon({ name }) {
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
export function Modal({ title, children, onClose }) {
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
      <div className="modal-title"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={20}/></button></div>{children}
    </div></div>;
}
export function LogPanel({ logs, busy, moveProgress, download, expanded = false }) {
  const [open, setOpen] = useState(expanded); const end = useRef();
  useEffect(() => { if (open || busy) end.current?.scrollIntoView({ block: 'nearest' }); }, [logs.length, open, busy]);
  const progress = moveProgress?.total ? moveProgress.completed / moveProgress.total * 100 : download?.percent;
  return <section className={`logs-panel ${busy ? 'running' : ''}`}>
    <button className="logs-heading" onClick={() => setOpen(!open)} aria-expanded={open || Boolean(busy)}>
      <span><Terminal size={17}/> {busy ? 'In progress' : 'Activity log'} {busy && <LoaderCircle className="spin" size={14}/>}</span>
      <span className="log-caption">{busy ? (moveProgress ? `${moveProgress.completed} / ${moveProgress.total} files` : download?.status ?? 'Working locally') : `${logs.length} events`}<ChevronDown size={16} className={open || busy ? 'rotated' : ''}/></span>
    </button>
    {busy && Number.isFinite(progress) && <div className="progress-track"><div style={{ width: `${progress}%` }}/></div>}
    {(open || busy) && <div className="log-lines" role="log" aria-live="polite" aria-label="Operation log">
      {logs.length ? logs.slice(-150).map((entry) => <div className={`log-line ${entry.level}`} key={entry.id}>
        <time>{new Date(entry.time).toLocaleTimeString('en', { hour12: false })}</time>
        {entry.level === 'success' ? <Check size={13}/> : entry.level === 'error' || entry.level === 'warning' ? <AlertCircle size={13}/> : <Circle size={9}/>}
        <span>{englishLogMessage(entry.message)}</span></div>) : <p className="quiet">Your operations will appear here.</p>}<div ref={end}/>
    </div>}
  </section>;
}
export function FolderCard({ group, root, editable, busy, edit, error, onDirty }) {
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
      if (item.rootId !== root.id) throw new Error('Move files between folders within the same source folder.');
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
    </div>) : <div className="empty-group"><FolderPlus size={20}/><span>Drop a file here.</span></div>}</div>
  </article>;
}

