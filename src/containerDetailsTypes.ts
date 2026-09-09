export interface ContainerDetails {
  sessionId: string;
  generation: number;
  handle: string;
  fullId: string;
  observedAt: string;
  diagnostics: {
    state: string;
    exitCode: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    oomKilled: boolean | null;
    restartCount: number | null;
    healthAvailable: boolean;
    healthConfigured: boolean | null;
    health: {
      status: string | null;
      failingStreak: number | null;
      recentFailures: HealthFailure[];
    } | null;
  };
  connectivity: {
    networkMode: string | null;
    portsAvailable: boolean;
    networksAvailable: boolean;
    ports: ContainerPort[];
    networks: ContainerNetwork[];
  };
}
export interface HealthFailure {
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number;
  output: string;
  truncated: boolean;
}
export interface ContainerPort {
  containerPort: number;
  protocol: string;
  bindings: { hostIp: string; hostPort: number | null }[];
}
export interface ContainerNetwork {
  name: string;
  aliases: string[];
  ipv4Address: string | null;
  ipv6Address: string | null;
}
