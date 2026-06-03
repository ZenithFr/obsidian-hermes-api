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
          await this.ensureFolderExists(payload.path);
          await this.app.vault.create(payload.path, payload.content);
        } catch (err) {
          console.error('[Hermes] Failed to create file from remote change:', err);
        }
      }
    };

    this.wsClient.onFileDeleted = async (payload) => {
      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (file) {
        try {
          await this.app.vault.trash(file, false); // move to system trash
        } catch (err) {
          console.error('[Hermes] Failed to process remote delete:', err);
        }
      }
    };

    this.wsClient.onFileRenamed = async (payload) => {
      const file = this.app.vault.getAbstractFileByPath(payload.old_path);
      if (file) {
        try {
          await this.ensureFolderExists(payload.new_path);
          await this.app.vault.rename(file, payload.new_path);
        } catch (err) {
          console.error('[Hermes] Failed to process remote rename:', err);
        }
      }
    };

    this.wsClient.onStateChange = (state: WsState) => {
      this.updateStatusBar(state);
    };

    this.wsClient.onConnected = (clientId: string) => {
      console.log(`[Hermes] Connected. Client ID: ${clientId}`);
      this.pullAllFiles();
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

    // ── Commands ──────────────────────────────────────────────────────────────
    this.addCommand({
      id: 'hermes-pull-all',
      name: 'Pull all files from server',
      callback: () => this.pullAllFiles(),
    });

    // ── Vault Events ──────────────────────────────────────────────────────────
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

    this.registerEvent(
      this.app.vault.on('delete', (file: TFile) => {
        if (!this.settings.syncOnModify) return;
        if (this.wsClient.getState() === WsState.CONNECTED) {
          this.wsClient.sendFileDelete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file: TFile, oldPath: string) => {
        if (!this.settings.syncOnModify) return;
        if (this.wsClient.getState() === WsState.CONNECTED) {
          this.wsClient.sendFileRename(oldPath, file.path);
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

  async pullAllFiles(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.apiToken) return;
    
    new Notice('Hermes: Syncing files from server...');
    try {
      const listResp = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files`,
        headers: { Authorization: `Bearer ${this.settings.apiToken}` }
      });
      const data = listResp.json;
      if (!data || !data.files) return;

      let created = 0;
      let updated = 0;

      for (const path of data.files) {
        const encodedPath = path.split('/').map((s: string) => encodeURIComponent(s)).join('/');
        const fileResp = await requestUrl({
          url: `${this.settings.serverUrl.replace(/\/$/, '')}/api/files/${encodedPath}`,
          headers: { Authorization: `Bearer ${this.settings.apiToken}` }
        });
        const remoteContent = fileResp.text;
        
        const localFile = this.app.vault.getAbstractFileByPath(path);
        if (localFile instanceof TFile) {
          const localContent = await this.app.vault.read(localFile);
          if (localContent !== remoteContent) {
            await this.app.vault.modify(localFile, remoteContent);
            updated++;
          }
        } else if (!localFile) {
          await this.ensureFolderExists(path);
          await this.app.vault.create(path, remoteContent);
          created++;
        }
      }
      
      if (created > 0 || updated > 0) {
        new Notice(`Hermes Sync Complete! Created: ${created}, Updated: ${updated}`);
      } else {
        new Notice('Hermes Sync Complete: Vault is up to date.');
      }
    } catch (err) {
      console.error('[Hermes] Pull failed:', err);
      new Notice('Hermes Sync Failed. Check console.');
    }
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

  private async ensureFolderExists(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop(); // remove filename
    let currentPath = '';
    
    for (const part of parts) {
      currentPath = currentPath === '' ? part : `${currentPath}/${part}`;
      const folder = this.app.vault.getAbstractFileByPath(currentPath);
      if (!folder) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (err) {
          // Ignore if it was created concurrently
        }
      }
    }
  }

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
