import { EventEmitter } from 'events';

export interface ActivityEntry {
  ts: number;
  device: string;
  input: string;
  command: string;
  protocol: 'VISCA' | 'ATEM' | 'System';
  message: string;
  targetName: string;
  targetIp: string;
}

interface PendingContext {
  device: string;
  input: string;
  command: string;
}

const MAX_ENTRIES = 500;

export class ActivityLog extends EventEmitter {
  private buffer: ActivityEntry[] = [];
  private pendingContext: PendingContext | null = null;

  setContext(device: string, input: string, command: string): void {
    this.pendingContext = { device, input, command };
  }

  addEntry(partial: Omit<ActivityEntry, 'ts' | 'device' | 'input' | 'command'>): void {
    // Context is sticky — once set by setContext(), it persists across every
    // subsequent entry until the next setContext() replaces it. This is so a
    // 60Hz stream of PTZ commands during a single stick motion all carry the
    // "Right Stick / Pan-Tilt" label instead of just the first packet on the
    // motion-start edge.
    const ctx = this.pendingContext ?? { device: 'unknown', input: '—', command: '—' };
    const entry: ActivityEntry = { ts: Date.now(), ...ctx, ...partial };
    if (this.buffer.length >= MAX_ENTRIES) this.buffer.shift();
    this.buffer.push(entry);
    this.emit('entry', entry);
  }

  addSystemEntry(command: string, message: string): void {
    const ctx = this.pendingContext ?? { device: '—', input: '—', command };
    const entry: ActivityEntry = {
      ts: Date.now(),
      device: ctx.device,
      input: ctx.input,
      command: ctx.command,
      protocol: 'System',
      message,
      targetName: '—',
      targetIp: '—',
    };
    if (this.buffer.length >= MAX_ENTRIES) this.buffer.shift();
    this.buffer.push(entry);
    this.emit('entry', entry);
  }

  getAll(): ActivityEntry[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}
