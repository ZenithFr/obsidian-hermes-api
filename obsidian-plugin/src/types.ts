// Settings stored in Obsidian's plugin data
export interface HermesSettings {
  serverUrl: string;
  apiToken: string;
  syncOnModify: boolean;
  autoReconnect: boolean;
  reconnectIntervalMs: number;
}

export const DEFAULT_SETTINGS: HermesSettings = {
  serverUrl: '',
  apiToken: '',
  syncOnModify: true,
  autoReconnect: true,
  reconnectIntervalMs: 3000,
};

// Inbound from server → client
export interface FileChangedPayload {
  type: 'FILE_CHANGED';
  path: string;
  content: string;
  source: 'ws' | 'rest';
  ts: string;
}

export interface FileDeletedPayload {
  type: 'FILE_DELETED';
  path: string;
  source: 'ws' | 'rest';
  ts: string;
}

export interface ConnectedPayload {
  type: 'CONNECTED';
  client_id: string;
}

export interface ErrorPayload {
  type: 'ERROR';
  code: string;
  message: string;
}

// Outbound from client → server
export interface FileModifyPayload {
  type: 'FILE_MODIFY';
  path: string;
  content: string;
}

// Quick Import config (base64 JSON from dashboard)
export interface QuickImportConfig {
  server: string;
  token: string;
}

export type InboundPayload =
  | FileChangedPayload
  | FileDeletedPayload
  | ConnectedPayload
  | ErrorPayload;
