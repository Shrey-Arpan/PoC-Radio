
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type PTTStatus = 'idle' | 'transmitting' | 'receiving' | 'interrupted';
export type AppMode = 'dispatch' | 'human';

export interface ChatMessage {
  id: string;
  sender: 'user' | 'dispatch' | 'peer';
  text: string;
  timestamp: Date;
}

export interface AudioConfig {
  inputSampleRate: number;
  outputSampleRate: number;
}
