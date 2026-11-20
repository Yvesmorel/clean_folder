import path from 'node:path';
import { validateShortcutPair } from '../src/shortcut.js';
import { randomUUID } from 'node:crypto';
import { createPlan, applyPlan, validateFolderName, validateOptions } from './engine.mjs';
import { defaultSettings } from './store.mjs';
import { getModels, pullModel, deleteModel, setupRuntime, validModel } from './runtime.mjs';

export class Service {
  constructor(store, emit = () => {}, dependencies = {}) {
    this.store = store; this.emit = emit; this.active = null; this.download = null; this.analysis = null;
    this.organizing = null; this.setupController = null; this.activeDone = null; this.shuttingDown = false;
    this.dependencies = { createPlan, applyPlan, getModels, pullModel, deleteModel, setupRuntime, ...dependencies };
  }
  log(level, message, extra = {}) { const entry = this.store.addLog(level, message, extra); this.emit('log', entry); return entry; }
  publicPlan(plan = this.store.state.currentPlan) {
    if (!plan) return null;
    return { id: plan.id, revision: plan.revision, status: plan.status, createdAt: plan.createdAt,
      roots: plan.roots.map((root) => {
        const metadata = new Map(root.snapshot.files.map((file) => [file.name, file]));
        return { id: root.id, path: root.snapshot.root, skipped: root.snapshot.skipped.length, content: root.snapshot.stats?.content,
          groups: root.groups.map((g) => ({ ...g, files: g.files.map((name) => ({ name, size: metadata.get(name)?.size ?? 0 })) })) };
      }) };
  }
  async state() {
    let models = [], connected = false, runtimeError = null;
    try { models = await this.dependencies.getModels(); connected = true; }
    catch (error) { runtimeError = error.message; }
    const settings = this.store.state.settings;
    const ready = connected && models.some((m) => m.local !== false && m.name === settings.embeddingModel && m.capabilities.includes('embedding')) &&
      models.some((m) => m.local !== false && m.name === settings.model && m.capabilities.includes('completion'));
    return { settings, models, connected, ready, runtimeError, operation: this.active,
      history: this.store.state.history, logs: this.store.state.logs, recentDirectories: this.store.state.recentDirectories,
      currentPlan: this.publicPlan(), setup: this.store.state.setup, dataDirectory: this.store.directory };
  }
  async task(name, fn) {
    if (this.shuttingDown) throw new Error('Clean_folder is closing.');
    if (this.active) throw new Error(`Please wait until ${this.active} finishes.`);
    let finish; this.activeDone = new Promise((resolve) => { finish = resolve; });
    this.active = name; this.emit('operation', name);
    try { return await fn(); }
    finally {
      try { await this.store.save(); }
      finally { this.active = null; this.activeDone = null; if (name === 'organizing') this.organizing = null; if (name === 'setup') this.setupController = null; this.emit('operation', null); finish(); }
    }
  }
  assertIdle() { if (this.active) throw new Error(`Please wait until ${this.active} finishes.`); }
  assertDraft(id, revision) {
    const plan = this.store.state.currentPlan;
    if (!plan || plan.id !== id || plan.status !== 'draft') throw new Error('This plan is no longer editable. Create a new plan.');
    if (plan.revision !== revision) throw new Error('The plan changed. Reload the latest review before continuing.');
    return plan;
  }
  async handle(method, args = {}) {
    if (this.shuttingDown && !['shutdown', 'get_state', 'cancel_analysis', 'cancel_download'].includes(method)) throw new Error('Clean_folder is closing.');
    switch (method) {
      case 'shutdown': {
        this.shuttingDown = true; this.emit('shutdown', true);
        const done = this.activeDone;
        this.analysis?.abort(); this.download?.abort(); this.organizing?.abort(); this.setupController?.abort();
        if (done) await done;
        await this.store.save(); return { readyToClose: true };
      }
      case 'get_state': return this.state();
      case 'setup_runtime': return this.task('setup', async () => {
        const controller = new AbortController(); this.setupController = controller;
        this.store.state.setup = { status: 'running' }; await this.store.save();
        try {
          await this.dependencies.setupRuntime(this.store.directory, this.log.bind(this), (progress) => this.emit('download', progress), { signal: controller.signal });
          this.store.state.setup = { status: 'ready', finishedAt: new Date().toISOString() };
        } catch (error) { this.store.state.setup = { status: 'failed', error: controller.signal.aborted ? 'Setup cancelled while closing Clean_folder.' : error.message }; this.log(controller.signal.aborted ? 'info' : 'error', this.store.state.setup.error); throw error; }
        finally { this.setupController = null; }
        return this.state();
      });
      case 'install_model': return this.task('download', async () => {
        const name = validModel(args.name); this.download = new AbortController();
        this.log('info', `Installing ${name}.`);
        try { await this.dependencies.pullModel(name, (progress) => this.emit('download', progress), { signal: this.download.signal });
          this.log('success', `${name} is installed.`); return this.state();
        } catch (error) { this.log('warning', `Model download stopped: ${error.message}`); throw error; }
        finally { this.download = null; }
      });
      case 'delete_model': return this.task('deleting model', async () => {
        const name = validModel(args.name);
        const models = await this.dependencies.getModels();
        if (!models.some((m) => m.name === name)) throw new Error('This model is no longer installed. Refresh Models.');
        this.log('info', `Deleting ${name} from Ollama.`);
        try { await this.dependencies.deleteModel(name); }
        catch (error) { this.log('error', `Model deletion failed: ${error.message}`); throw error; }
        const settings = { ...this.store.state.settings };
        const remaining = models.filter((m) => m.name !== name && m.local !== false);
        for (const [setting, capability] of [['model', 'completion'], ['embeddingModel', 'embedding']]) {
          if (settings[setting] === name) {
            const replacement = remaining.find((m) => m.capabilities.includes(capability));
            if (replacement) settings[setting] = replacement.name;
          }
        }
        this.store.state.settings = settings;
        // A deliberate deletion must not be undone by automatic setup on restart.
        this.store.state.setup = { ...this.store.state.setup, autoSetupDisabled: true };
        await this.store.save();
        this.log('success', `${name} was deleted from Ollama.`);
        return this.state();
      });
      case 'cancel_download': if (this.download) this.download.abort(); return { cancelled: Boolean(this.download) };
      case 'cancel_analysis': {
        const cancelled = this.active === 'analysis' && Boolean(this.analysis);
        if (cancelled) this.analysis.abort();
        return { cancelled };
      }
      case 'save_settings': {
        this.assertIdle(); const previous = this.store.state.settings;
        const allowed = Object.keys(defaultSettings); const settings = { ...previous };
        for (const [name, value] of Object.entries(args.settings ?? {})) {
          if (!allowed.includes(name)) throw new Error(`Unsupported setting: ${name}`); settings[name] = value;
        }
        validateShortcutPair(settings);
        if (!['white', 'black'].includes(settings.theme)) throw new Error('Choose the light or dark theme.');
        validateOptions(settings); validModel(settings.model); validModel(settings.embeddingModel);
        if (!['French', 'English'].includes(settings.folderLanguage)) throw new Error('Select a valid folder language.');
        if (settings.model !== previous.model || settings.embeddingModel !== previous.embeddingModel) {
          const models = await this.dependencies.getModels();
          if (!models.some((m) => m.local !== false && m.name === settings.model && m.capabilities.includes('completion'))) throw new Error('Select an installed local text-generation model.');
          if (!models.some((m) => m.local !== false && m.name === settings.embeddingModel && m.capabilities.includes('embedding'))) throw new Error('Select an installed local embedding model.');
        }
        this.store.state.settings = settings; await this.store.save(); this.log('success', 'Preferences saved on this device.');
        this.emit('settings', settings);
        await this.store.save(); return settings;
      }
      case 'create_plan': return this.task('analysis', async () => {
        const controller = new AbortController(); this.analysis = controller;
        const signal = controller.signal;
        try {
          if (!Array.isArray(args.directories) || !args.directories.length || args.directories.length > 30 ||
            args.directories.some((d) => typeof d !== 'string' || !d.trim())) throw new Error('Choose 1–30 source directories.');
          const current = this.store.state.currentPlan;
          if (current?.status === 'draft') throw new Error('Discard the current draft before creating a new plan.');
          const settings = { ...this.store.state.settings };
          const models = await this.dependencies.getModels({ signal });
          signal.throwIfAborted();
          const namingModel = models.find((m) => m.name === settings.model && m.local !== false && m.capabilities.includes('completion'));
          if (!namingModel || !models.some((m) => m.name === settings.embeddingModel && m.local !== false && m.capabilities.includes('embedding'))) {
            throw new Error('Your selected local models are unavailable. Refresh Models and choose installed models.');
          }
          settings.thinkingSupported = namingModel.capabilities.includes('thinking');
          const roots = [], seen = new Set();
          this.log('info', 'Analyzing selected directories. No files will be moved.');
          for (const directory of [...new Set(args.directories)]) {
            signal.throwIfAborted();
            this.log('info', `Reading top-level entries in ${directory}.`);
            const snapshot = await this.dependencies.createPlan(directory, settings, {
              signal,
              onProgress: (message) => this.log('info', message),
            });
            signal.throwIfAborted();
            if (seen.has(snapshot.root)) continue;
            if (roots.some((r) => isNested(r.snapshot.root, snapshot.root) || isNested(snapshot.root, r.snapshot.root))) {
              throw new Error('Select separate directories. A directory and its own subdirectory cannot be organized in the same run.');
            }
            seen.add(snapshot.root);
            roots.push({ id: randomUUID(), snapshot,
              groups: snapshot.groups.map((g) => ({ id: randomUUID(), ...g })) });
            if (snapshot.skipped.length) this.log('warning', `${snapshot.skipped.length} link(s) or unsupported entry(s) skipped in ${snapshot.root}.`);
            this.log('success', `Proposed ${snapshot.groups.length} folder(s) for ${snapshot.files.length} file(s) in ${snapshot.root}.`);
          }
          const plan = { id: randomUUID(), revision: 1, status: 'draft', createdAt: new Date().toISOString(), roots };
          signal.throwIfAborted();
          this.analysis = null; // The plan is complete; cancellation no longer applies during saving.
          this.store.state.currentPlan = plan;
          this.store.state.recentDirectories = [...roots.map((r) => r.snapshot.root), ...this.store.state.recentDirectories]
            .filter((v, i, a) => a.indexOf(v) === i).slice(0, 30);
          await this.store.save(); this.log('success', 'Your review is ready. Edit it freely before moving any files.');
          return this.publicPlan(plan);
        } catch (error) {
          if (!signal.aborted) throw error;
          this.log('info', 'Plan creation cancelled. No files were moved.');
          return { cancelled: true };
        } finally { if (this.analysis === controller) this.analysis = null; }
      });
      case 'edit_plan': {
        this.assertIdle(); const previous = this.assertDraft(args.planId, args.revision);
        const plan = structuredClone(previous), root = plan.roots.find((r) => r.id === args.rootId);
        if (!root) throw new Error('Unknown source directory.');
        const group = root.groups.find((g) => g.id === args.groupId);
        if (args.action === 'rename_group' || args.action === 'add_group') {
          const name = validateFolderName(args.name);
          const directories = new Set(root.snapshot.directories.map((d) => d.normalize('NFC').toLowerCase()));
          const blocked = root.snapshot.occupied.some((d) => d.normalize('NFC').toLowerCase() === name.toLowerCase() && !directories.has(d.normalize('NFC').toLowerCase()));
          if (blocked) throw new Error('That folder name is occupied by a file or symbolic link. Choose a different name.');
          const duplicate = root.groups.find((g) => g.id !== args.groupId && g.folder.normalize('NFC').toLowerCase() === name.toLowerCase());
          const existing = root.snapshot.directories.find((d) => d.normalize('NFC').toLowerCase() === name.toLowerCase());
          if (args.action === 'rename_group') {
            if (!group) throw new Error('Unknown folder group.');
            if (duplicate) { duplicate.files.push(...group.files); root.groups = root.groups.filter((g) => g.id !== group.id); }
            else group.folder = existing ?? name;
          } else if (!duplicate) root.groups.push({ id: randomUUID(), folder: existing ?? name, files: [] });
        } else if (args.action === 'move_file') {
          const destination = root.groups.find((g) => g.id === args.destinationGroupId);
          if (!group || !destination || !group.files.includes(args.file)) throw new Error('Unknown file or destination group.');
          if (group.id !== destination.id) {
            group.files = group.files.filter((f) => f !== args.file); destination.files.push(args.file);
          }
        } else throw new Error('Unknown review edit.');
        plan.revision++; this.store.state.currentPlan = plan; await this.store.save(); return this.publicPlan(plan);
      }
      case 'discard_plan': {
        this.assertIdle(); this.assertDraft(args.planId, args.revision);
        this.store.state.currentPlan = null; await this.store.save(); return { discarded: true };
      }
      case 'archive_plan': {
        this.assertIdle(); if (this.store.state.currentPlan?.status === 'draft') throw new Error('Use discard to remove an editable draft.');
        this.store.state.currentPlan = null; await this.store.save(); return { archived: true };
      }
      case 'apply_plan': return this.task('organizing', async () => {
        const controller = new AbortController(); this.organizing = controller;
        const plan = this.assertDraft(args.planId, args.revision);
        const total = plan.roots.reduce((n, r) => n + r.snapshot.files.length, 0);
        if (!total) throw new Error('There are no files to move in this plan.');
        plan.status = 'applying';
        const run = { id: randomUUID(), planId: plan.id, startedAt: new Date().toISOString(), status: 'applying',
          directories: plan.roots.map((r) => r.snapshot.root), total, moved: 0, errors: 0, entries: [] };
        this.store.state.history.unshift(run);
        await this.store.save();
        this.log('info', `Applying the approved plan for ${total} file(s). Analysis will not run again.`, { runId: run.id });
        try {
          for (const root of plan.roots) {
            const exactPlan = { ...root.snapshot, groups: root.groups.filter((g) => g.files.length).map(({ folder, files }) => ({ folder, files })) };
            await this.dependencies.applyPlan(exactPlan, {
              signal: controller.signal,
              onProgress: (message) => this.log('info', message, { runId: run.id }),
              onFileResult: async (entry) => {
                run.entries.push({ ...entry, root: root.snapshot.root, time: new Date().toISOString() });
                if (entry.ok) { run.moved++; this.log('success', `Moved ${entry.from} → ${entry.to}`, { runId: run.id, root: root.snapshot.root }); }
                else { run.errors++; this.log('error', `${entry.file}: ${entry.error}`, { runId: run.id, root: root.snapshot.root }); }
                // Receipts are durably saved after each actual move, not reconstructed later.
                await this.store.save(); this.emit('move_progress', { completed: run.moved + run.errors, total, moved: run.moved, errors: run.errors });
              },
            });
          }
          run.status = run.errors ? 'partial' : 'completed'; plan.status = run.status;
          this.log(run.errors ? 'warning' : 'success', `${run.moved} file(s) organized, ${run.errors} error(s).`, { runId: run.id });
        } catch (error) {
          run.status = 'interrupted'; plan.status = 'interrupted'; run.failure = error.message;
          this.log('error', `Organization stopped: ${error.message}`, { runId: run.id });
          throw error;
        } finally { this.organizing = null; run.finishedAt = new Date().toISOString(); await this.store.save(); }
        return { plan: this.publicPlan(plan), run };
      });
      default: throw new Error('Unsupported application command.');
    }
  }
}
function isNested(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
