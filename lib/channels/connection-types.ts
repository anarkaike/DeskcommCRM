import type { ChannelProvider, ChannelTenantScope } from "./types";

/** Estado operacional comum de uma conexão de canal. */
export type ChannelConnectionStatus = "draft" | "configured" | "active" | "paused" | "disconnected" | "error" | "deleted";

/** Capacidades efetivamente concedidas a uma conexão, não capacidades teóricas do provider. */
export interface ChannelConnectionGrant {
  surface: string;
  capabilities: readonly string[];
}

/** Prova mínima de conexão retornada pelo provider; credenciais nunca são incluídas. */
export interface ChannelConnectionIdentity {
  providerAccountId: string;
  displayName?: string | null;
  username?: string | null;
}

export interface ChannelConnectionHealth {
  healthy: boolean;
  checkedAt: string;
  state: "connected" | "degraded" | "disconnected" | "unknown";
  pendingCount?: number | null;
  lastErrorAt?: string | null;
  webhookMatches?: boolean;
  detailCode?: string;
}

/** Contexto seguro e tenant-scoped usado pelos serviços compartilhados de conexão. */
export interface ChannelConnectionContext extends ChannelTenantScope {
  connectionId: string;
  actorUserId: string;
  currentStatus?: ChannelConnectionStatus;
  action?: ConnectionLifecycleAction;
  /** Provider-owned immutable account identity used to prevent credential substitution. */
  expectedAccountId?: string;
  /** Host request used to construct a provider callback URL without build-time env leakage. */
  request?: { headers: Headers; nextUrl: URL };
}

/**
 * Porta implementada pelo provider para as operações que dependem da sua API.
 * A máquina de estados e os limites de permissão ficam no núcleo; protocolo,
 * validação da credencial e operações remotas ficam no provider.
 */
export interface ChannelConnectionDriver<TCredential = unknown> {
  readonly provider: ChannelProvider;
  validateCredential(credential: TCredential): Promise<ChannelConnectionIdentity | null>;
  activate(context: ChannelConnectionContext): Promise<void>;
  deactivate(context: ChannelConnectionContext): Promise<void>;
  health(context: ChannelConnectionContext): Promise<ChannelConnectionHealth>;
}

/** Estado e grants normalizados para política compartilhada e conformidade. */
export interface ChannelConnectionRecord {
  provider: ChannelProvider;
  status: ChannelConnectionStatus;
  grants: readonly ChannelConnectionGrant[];
}

export type ConnectionLifecycleAction = "activate" | "pause" | "reactivate" | "disconnect" | "delete";\n