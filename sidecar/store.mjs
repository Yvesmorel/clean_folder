import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultSettings = { embeddingModel: 'qwen3-embedding:0.6b', model: 'llama3.2:1b',
  threshold: 0.7, batchSize: 32, maxTokens: 64, folderLanguage: 'English', visibilityShortcut: '',
  theme: 'white', inspectContent: true, quickAccessShortcut: 'Control+Alt+Space' };
export function dataDirectory() {
  return process.env.CLEAN_FOLDER_DATA_DIR || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Clean_folder')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Clean_folder'));
}
export class Store {
  constructor(directory = dataDirectory()) { this.directory = directory; this.queue = Promise.resolve(); }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, 'state.json');
    try { this.state = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Local data could not be loaded. Your files have not been touched. ${error.message}`);
      this.state = { version: 1, settings: { ...defaultSettings }, recentDirectories: [], history: [],
        logs: [], currentPlan: null, setup: { status: 'pending' } };
    }
    if (this.state.version !== 1) throw new Error('Unsupported local database version.');
    this.state.settings = { ...defaultSettings, ...this.state.settings };
    if (this.state.currentPlan?.status === 'applying') {
      this.state.currentPlan.status = 'interrupted';
      const run = this.state.history.find((r) => r.planId === this.state.currentPlan.id);
      if (run) { run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); }
      this.addLog('warning', 'The previous operation was interrupted. Review the recorded moves before creating a new plan.');
    }
    await this.save();
    return this;
  }
  addLog(level, message, extra = {}) {
    const entry = { id: randomUUID(), time: new Date().toISOString(), level, message, ...extra };
    this.state.logs.push(entry); this.state.logs = this.state.logs.slice(-3000);
    return entry;
  }
  save() {
    const content = JSON.stringify(this.state, null, 2);
    const task = this.queue.then(async () => {
      const file = path.join(this.directory, 'state.json');
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      try { await fs.rename(temporary, file); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
