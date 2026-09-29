import type { OfficeHoursConfig } from './contract';

interface EditorState {
  config: OfficeHoursConfig;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

interface EditorApi {
  load: (signal: AbortSignal) => Promise<OfficeHoursConfig>;
  save: (config: OfficeHoursConfig, signal: AbortSignal) => Promise<{ config: OfficeHoursConfig }>;
}

/** Owns load/save ordering independently of React render timing. */
export class OfficeHoursEditor {
  private api: EditorApi;
  private state: EditorState = {
    config: { rules: [], version: 1 }, loaded: false, loading: true, saving: false, error: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | null = null;

  constructor(api: EditorApi) { this.api = api; }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(update: Partial<EditorState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }

  async load(): Promise<void> {
    if (this.state.saving) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const generation = ++this.generation;
    this.update({ loaded: false, loading: true, error: null });
    try {
      const config = await this.api.load(request.signal);
      if (generation !== this.generation || request.signal.aborted) return;
      this.update({ config, loaded: true, loading: false });
    } catch (error) {
      if (generation !== this.generation || request.signal.aborted) return;
      this.update({ loading: false, error: error instanceof Error ? error.message : 'Failed to load saved office hours.' });
    }
  }

  async save(update: (current: OfficeHoursConfig) => OfficeHoursConfig): Promise<OfficeHoursConfig | null> {
    if (!this.state.loaded || this.state.loading || this.state.saving) return null;
    const request = new AbortController();
    this.request = request;
    const generation = ++this.generation;
    this.update({ saving: true, error: null });
    try {
      const result = await this.api.save(update(this.state.config), request.signal);
      if (generation !== this.generation || request.signal.aborted) return null;
      this.update({ config: result.config, saving: false });
      return result.config;
    } catch (error) {
      if (generation !== this.generation || request.signal.aborted) return null;
      this.update({ saving: false, error: error instanceof Error ? error.message : 'Failed to save office hours.' });
      throw error;
    }
  }

  /** Invalidate results even when a transport does not honor AbortSignal. */
  cancel() {
    ++this.generation;
    this.request?.abort();
    this.request = null;
    this.update({ loaded: false, loading: false, saving: false });
  }
}
