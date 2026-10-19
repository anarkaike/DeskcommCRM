import type {
  ChannelConnectionDriver,
  ChannelConnectionRecord,
  ChannelConnectionContext,
  ConnectionLifecycleAction,
} from "./connection-types";

export type LifecycleRejection = "already_active" | "invalid_transition" | "missing_required_grant";
export type LifecycleDecision = { allowed: true; nextStatus: "active" | "paused" | "disconnected" | "deleted" }
  | { allowed: false; reason: LifecycleRejection };

/** Policy pura: todos os drivers usam a mesma transição e validação de grants. */
export function decideConnectionLifecycle(
  record: ChannelConnectionRecord,
  action: ConnectionLifecycleAction,
  requiredGrants: readonly { surface: string; capability: string }[] = [],
): LifecycleDecision {
  if (action === "activate" || action === "reactivate") {
    if (record.status === "active") return { allowed: false, reason: "already_active" };
    if (record.status === "deleted") return { allowed: false, reason: "invalid_transition" };
    const granted = new Set(record.grants.flatMap((grant) => grant.capabilities.map((capability) => `${grant.surface}:${capability}`)));
    if (requiredGrants.some(({ surface, capability }) => !granted.has(`${surface}:${capability}`))) {
      return { allowed: false, reason: "missing_required_grant" };
    }
    return { allowed: true, nextStatus: "active" };
  }
  if (record.status === "deleted") return { allowed: false, reason: "invalid_transition" };
  if (action === "pause") {
    return record.status === "active"
      ? { allowed: true, nextStatus: "paused" }
      : { allowed: false, reason: "invalid_transition" };
  }
  if (action === "disconnect") return { allowed: true, nextStatus: "disconnected" };
  return { allowed: true, nextStatus: "deleted" };
}

/**
 * Template Method para lifecycle comum. O provider implementa somente o trabalho
 * remoto; persistência/auditoria continua no serviço de aplicação que chama esta porta.
 */
export function createConnectionLifecycle<TCredential>(driver: ChannelConnectionDriver<TCredential>) {
  return {
    validate: (credential: TCredential) => driver.validateCredential(credential),
    async activate(context: ChannelConnectionContext, record: ChannelConnectionRecord, requiredGrants: readonly { surface: string; capability: string }[] = []) {
      const decision = decideConnectionLifecycle(record, "activate", requiredGrants);
      if (!decision.allowed) return decision;
      await driver.activate({ ...context, currentStatus: record.status, action: "activate" });
      return decision;
    },
    async deactivate(context: ChannelConnectionContext, record: ChannelConnectionRecord, action: "pause" | "disconnect" | "delete") {
      const decision = decideConnectionLifecycle(record, action);
      if (!decision.allowed) return decision;
      await driver.deactivate({ ...context, currentStatus: record.status, action });
      return decision;
    },
    health: (context: ChannelConnectionContext) => driver.health(context),
  };
}\n