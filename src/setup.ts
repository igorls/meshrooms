export type PendingRoom = {
  id: string;
  title: string;
  project: string;
  agentName: string;
  status: 'pending' | 'completed';
  roomId?: string;
};

export type SetupStatus = {
  completed: boolean;
  humanName: string;
  machineName: string;
  dataDir: string;
  startup: { preference: 'manual' | 'login'; installed: boolean; supported: boolean; message?: string };
  pending?: PendingRoom;
};

export type SetupCommand = {
  requestId: string;
  humanName: string;
  machineName: string;
  startAtLogin: boolean;
  intentId?: string;
};
