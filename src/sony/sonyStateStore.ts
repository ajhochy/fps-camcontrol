import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const SAFE_ID = /^[A-Za-z0-9:-]{1,128}$/;
const ALLOWED_FIELDS = new Set(['id', 'model', 'connectionType']);

export interface ApprovedSonyCamera {
  id: string;
  model?: string;
  connectionType?: string;
  approvedAt: string;
}

export interface SonyCameraApproval {
  id: string;
  model?: string;
  connectionType?: string;
}

interface SonyStateFile {
  version: 1;
  approvedCameras: ApprovedSonyCamera[];
}

export interface SonyStateStoreDependencies {
  /** Override only filesystem boundaries needed by focused failure tests. */
  fs?: { rename?: (oldPath: string, newPath: string) => Promise<void> };
  now?: () => Date;
}

/** Durable, local approval list. It intentionally never stores camera credentials. */
export class SonyStateStore {
  private pending: Promise<void> = Promise.resolve();
  private readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly stateFile: string, dependencies: SonyStateStoreDependencies = {}) {
    this.rename = dependencies.fs?.rename ?? fs.promises.rename;
    this.now = dependencies.now ?? (() => new Date());
  }

  async load(): Promise<ApprovedSonyCamera[]> {
    try {
      return this.parse(await fs.promises.readFile(this.stateFile, 'utf8')).approvedCameras;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      await this.quarantine();
      return [];
    }
  }

  approve(approval: SonyCameraApproval): Promise<void> {
    return this.enqueue(async () => {
      this.validateApproval(approval);
      const approvals = await this.load();
      const previous = approvals.find((camera) => camera.id === approval.id);
      const next = approvals.filter((camera) => camera.id !== approval.id);
      next.push({
        id: approval.id,
        model: approval.model ?? previous?.model,
        connectionType: approval.connectionType ?? previous?.connectionType,
        approvedAt: previous?.approvedAt ?? this.now().toISOString(),
      });
      await this.write(next);
    });
  }

  forget(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!SAFE_ID.test(id)) throw new Error('Sony camera ID must be a safe identifier');
      await this.write((await this.load()).filter((camera) => camera.id !== id));
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private parse(content: string): SonyStateFile {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== 'object') throw new Error('invalid Sony state');
    const state = value as Partial<SonyStateFile>;
    if (state.version !== 1 || !Array.isArray(state.approvedCameras)) throw new Error('invalid Sony state schema');
    const ids = new Set<string>();
    for (const camera of state.approvedCameras) {
      // `gimbalDevice` was a short-lived field (a camera's gimbal is now the rig that names the camera). Drop it
      // quietly rather than treating the whole approval file as corrupt.
      if (camera && typeof camera === 'object') delete (camera as unknown as Record<string, unknown>).gimbalDevice;
      this.validateCamera(camera);
      if (ids.has(camera.id)) throw new Error('duplicate Sony camera ID');
      ids.add(camera.id);
    }
    return { version: 1, approvedCameras: state.approvedCameras };
  }

  private validateCamera(camera: ApprovedSonyCamera): void {
    this.validateApproval({ id: camera.id, model: camera.model, connectionType: camera.connectionType });
    if (typeof camera.approvedAt !== 'string' || new Date(camera.approvedAt).toISOString() !== camera.approvedAt) {
      throw new Error('Sony approval timestamp must be ISO-8601');
    }
    if (Object.keys(camera).some((key) => !ALLOWED_FIELDS.has(key) && key !== 'approvedAt')) {
      throw new Error('Sony approval contains unsupported fields');
    }
  }

  private validateApproval(approval: SonyCameraApproval): void {
    if (!approval || typeof approval !== 'object' || !SAFE_ID.test(approval.id)) {
      throw new Error('Sony camera ID must be a safe identifier');
    }
    if (Object.keys(approval).some((key) => !ALLOWED_FIELDS.has(key))) {
      throw new Error('Sony approval contains unsupported fields');
    }
    if ((approval.model !== undefined && typeof approval.model !== 'string') ||
      (approval.connectionType !== undefined && typeof approval.connectionType !== 'string')) {
      throw new Error('Sony approval metadata must be strings');
    }
  }

  private async write(approvedCameras: ApprovedSonyCamera[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(this.stateFile), `.${path.basename(this.stateFile)}.${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ version: 1, approvedCameras })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.rename(temporary, this.stateFile);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.promises.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async quarantine(): Promise<void> {
    const suffix = this.now().toISOString().replace(/[:.]/g, '-');
    const quarantined = `${this.stateFile}.corrupt-${suffix}-${randomUUID()}`;
    await fs.promises.rename(this.stateFile, quarantined).catch(() => undefined);
  }
}
