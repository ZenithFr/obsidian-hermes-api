import { Plugin, TFile, Notice, requestUrl } from 'obsidian';
import { HermesSettings, DEFAULT_SETTINGS } from './types';
import { HermesWsClient, WsState, createWsClient } from './ws-client';
import { HermesSettingTab } from './settings';

export default class HermesPlugin extends Plugin {
  settings!: HermesSettings;
  wsClient!: HermesWsClient;
  private statusBarItem!: HTMLElement;

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Create WebSocket client
    this.wsClient = createWsClient();
    this.wsClient.setAutoReconnect(this.settings.autoReconnect);

    // ── WS Callbacks ──────────────────────────────────────────────────────────

    this.wsClient.onFileChanged = async (payload) => {
      const file = this.app.vault.getAbstractFileByPath(payload.path);

      if (file instanceof TFile) {
        // Echo-loop prevention: only write if content actually differs
        const currentContent = await this.app.vault.read(file);
        if (currentContent !== payload.content) {
          await this.app.vault.modify(file, payload.content);
        }
      } else if (!file) {
        // File doesn't exist locally yet — create it
        try {
          // Ensure parent directories exist by creating the file with full path
          await this.app.vault.create(payload.path, payload.content);
        } catch (err) {
          console.error('[Hermes] Failed to create file from remote change:', err);
        }
      }
    };

    this.wsClient.onFileDeleted = (payload) => {
      // We intentionally do NOT auto-delete from the vault — too destructive.
      // Instead, inform the user so they can decide.
      new Notice(
        `🗑️ Hermes: Remote deletion of "${payload.path}" — file kept locally. Remove manually if desired.`
      );
    };

    this.wsClient.onStateChange = (state: WsState) => {
      this.updateStatusBar(state);
    };

    this.wsClient.onConnected = (clientId: string) => {
      console.log(`[Hermes] Connected. Client ID: ${clientId}`);
    };

    this.wsClient.onError = (payload) => {
      new Notice(`⚠️ Hermes error [${payload.code}]: ${payload.message}`);
    };

    // ── Settings Tab ──────────────────────────────────────────────────────────
    this.addSettingTab(new HermesSettingTab(this.app, this));

    // ── Status Bar ────────────────────────────────────────────────────────────
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(WsState.DISCONNECTED);

    // ── Auto-connect on startup ───────────────────────────────────────────────
    if (this.settings.serverUrl && this.settings.apiToken) {
      this.connectWs();
    }

    // ── Vault Modify Event ────────────────────────────────────────────────────
    this.registerEvent(
      this.app.vault.on('modify', async (file: TFile) => {
        if (!this.settings.syncOnModify) return;

        if (this.wsClient.getState() === WsState.CONNECTED) {
          const content = await this.app.vault.read(file);
          this.wsClient.sendFileModify(file.path, content);
        } else if (this.settings.serverUrl && this.settings.apiToken) {
          // HTTP fallback when WebSocket is not available
          await this.httpFallbackWrite(file);
        }
      })
    );

    // ── Ribbon Icon ───────────────────────────────────────────────────────────
    this.addRibbonIcon('sync', 'Hermes Vault Sync', () => {
      const state = this.wsClient.getState();
      const messages: Record<WsState, string> = {
        [WsState.CONNECTED]: '🟢 Hermes: Connected and syncing.',
        [WsState.CONNECTING]: '🟡 Hermes: Connecting to server…',
        [WsState.RECONNECTING]: '🟡 Hermes: Reconnecting to server…',
        [WsState.DISCONNECTED]: '🔴 Hermes: Disconnected. Check settings.',
      };
      new Notice(messages[state] ?? `Hermes state: ${state}`);
    });
  }

  onunload(): void {
    this.wsClient.disconnect();
  }

  // ─── Public Methods ─────────────────────────────────────────────────────────

  connectWs(): void {
    this.wsClient.connect(this.settings.serverUrl, this.settings.apiToken);
  }

  async httpFallbackWrite(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);

      // Encode the file path so it's safe in a URL segment
      const encodedPath = file.path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');

      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: content,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      new Notice(`⚠️ Hermes HTTP fallback failed: ${message}`);
      console.error('[Hermes] HTTP fallback error:', err);
    }
  }

  // ─── Settings Persistence ────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<HermesSettings>
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private updateStatusBar(state: WsState): void {
    const labels: Record<WsState, string> = {
      [WsState.CONNECTED]: '🟢 Hermes',
      [WsState.CONNECTING]: '🟡 Hermes',
      [WsState.RECONNECTING]: '🟡 Hermes',
      [WsState.DISCONNECTED]: '🔴 Hermes',
    };
    this.statusBarItem.setText(labels[state] ?? 'Hermes');
  }
}
