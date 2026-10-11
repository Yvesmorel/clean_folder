import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const BASE = 'http://127.0.0.1:11434';
export function validModel(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,149}$/u.test(name)) throw new Error('Enter a valid Ollama model name, for example llama3.2:1b.');
  if (/:.*cloud$/iu.test(name)) throw new Error('Choose a local model tag. Clean_folder uses models that run on this device.');
  return name;
}
export async function ollamaRequest(endpoint, payload, { base = BASE, timeout = 120000, signal } = {}) {
  const response = await fetch(`${base}${endpoint}`, { method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: signal ?? AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
  return response;
}
export async function getModels({ base = BASE } = {}) {
  const data = await (await ollamaRequest('/api/tags', undefined, { base, timeout: 3000 })).json();
  const models = [];
  for (const model of data.models ?? []) {
    let capabilities = [], local = !(model.remote_model || model.remote_host);
    try { const details = await (await ollamaRequest('/api/show', { model: model.name }, { base, timeout: 15000 })).json();
      capabilities = details.capabilities ?? []; local = local && !(details.remote_model || details.remote_host);
    } catch { /* Visible as unknown, never assumed to be usable. */ }
    models.push({ name: model.name, size: model.size, modifiedAt: model.modified_at,
      parameterSize: model.details?.parameter_size, capabilities, local });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
export async function pullModel(name, onProgress, { base = BASE, signal } = {}) {
  validModel(name);
  const response = await ollamaRequest('/api/pull', { model: name, stream: true }, {
    base, timeout: 24 * 60 * 60 * 1000, signal });
  let buffer = '', lastProgress = 0, success = false;
  const consume = (line) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) throw new Error(data.error);
    if (data.status === 'success') success = true;
    const now = Date.now();
    if (now - lastProgress > 200 || data.status === 'success' || !data.total) {
      onProgress({ model: name, status: data.status, total: data.total, completed: data.completed,
        percent: data.total ? Math.round((data.completed ?? 0) / data.total * 100) : null });
      lastProgress = now;
    }
  };
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
  }
  buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
  if (!success) throw new Error('The model download ended before Ollama confirmed success. Retry to resume it.');
}
async function reachable() {
  try { await ollamaRequest('/api/tags', undefined, { timeout: 2000 }); return true; } catch { return false; }
}
async function waitForServer() {
  for (let i = 0; i < 60; i++) { if (await reachable()) return; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('Ollama did not start. Retry setup or restart Windows.');
}
function execute(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', (data) => { output = (output + data.toString()).slice(-4000); });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Dependency installation failed (${code}). ${output}`)));
  });
}
async function startOllama(executable, log) {
  const child = spawn(executable, ['serve'], { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); log('info', 'Starting the local Ollama service.'); await waitForServer();
}
async function installOllama(directory, log, progress) {
  if (process.platform !== 'win32') {
    throw new Error('Automatic Ollama installation is available on Windows x64. Install Ollama manually on this development system.');
  }
  const executable = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
  try { await fs.access(executable); await startOllama(executable, log); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  log('info', 'Downloading the official Ollama Windows installer.');
  const installer = path.join(directory, 'OllamaSetup.exe');
  const response = await fetch('https://ollama.com/download/OllamaSetup.exe', { signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Ollama download failed: HTTP ${response.status}.`);
  const total = Number(response.headers.get('content-length')) || null;
  let completed = 0, last = 0;
  const stream = Readable.from((async function* () {
    for await (const chunk of response.body) {
      completed += chunk.length;
      if (Date.now() - last > 300) { progress({ status: 'Downloading Ollama', completed, total,
        percent: total ? Math.round(completed / total * 100) : null }); last = Date.now(); }
      yield chunk;
    }
  })());
  await pipeline(stream, createWriteStream(installer));
  log('info', 'Verifying the installer signature and installing Ollama.');
  const script = path.join(directory, 'install-ollama.ps1');
  // The installer path is an argument, never interpolated into shell source.
  await fs.writeFile(script, `param([Parameter(Mandatory=$true)][string]$Installer)\n$ErrorActionPreference = 'Stop'\n$signature = Get-AuthenticodeSignature -LiteralPath $Installer\nif ($signature.Status -ne 'Valid') { throw 'Ollama installer signature validation failed.' }\n$process = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait -PassThru\nif ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw ('Ollama installer exit code: ' + $process.ExitCode) }\n`);
  try { await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Installer', installer]); }
  finally { await fs.rm(script, { force: true }); await fs.rm(installer, { force: true }); }
  if (!await reachable()) await startOllama(executable, log);
}
export async function setupRuntime(directory, log, progress) {
  await fs.mkdir(directory, { recursive: true });
  log('info', 'Checking the local Ollama installation.');
  if (!await reachable()) await installOllama(directory, log, progress);
  for (const name of ['qwen3-embedding:0.6b', 'llama3.2:1b']) {
    const tags = await (await ollamaRequest('/api/tags')).json();
    if ((tags.models ?? []).some((m) => m.name === name)) { log('success', `${name} is already installed.`); continue; }
    log('info', `Downloading ${name}.`);
    await pullModel(name, (p) => { progress(p); if (p.percent === null || p.status === 'success') log('info', `${name}: ${p.status}`); });
  }
  log('success', 'Ollama and the default models are ready.');
}
