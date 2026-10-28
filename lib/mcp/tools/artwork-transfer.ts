import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import type { McpToolDefinition } from "../types";
import { abrirChaveArtworkMcpExterno } from "@/lib/mcp/servidor-externo/segredo";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";

const inputShape = {
  message_id: z.string().uuid().describe("ID de uma mensagem inbound desta conversa que contenha um arquivo recebido do cliente."),
};

const TTL_MS = 15 * 60 * 1000;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** Emits a one-time opaque ticket for exactly one inbound attachment in this turn. */
export const crmCreateArtworkTransfer: McpToolDefinition<typeof inputShape> = {
  name: "crm_create_artwork_transfer",
  description:
    "Prepara a transferência segura de um arquivo que o cliente anexou nesta conversa para o catálogo comercial WordPress. Passe somente o message_id de uma mensagem inbound com mídia; a identidade de contato/conversa vem do turno e não pode ser escolhida. Retorna um ticket temporário de uso único, nunca um caminho ou URL do Storage. Use apenas quando o fluxo de venda precisar importar a arte/documento recebido.",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  redigirParaAuditoria: () => ({ message_id: "[redigido]" }),
  handler: async (input, ctx) => {
    const contactId = ctx.contatoDoTurno;
    const conversationId = ctx.conversaDoTurno;
    if (!contactId || !conversationId) return { ok: false, code: "trusted_turn_required" };

    const { data: org, error: orgError } = await ctx.supabase
      .from("organizations")
      .select("mcp_externo_artwork_encrypted,mcp_externo_artwork_iv,mcp_externo_artwork_tag,mcp_externo_artwork_blog_id")
      .eq("id", ctx.organizationId)
      .maybeSingle();
    if (orgError || !org) return { ok: false, code: "bridge_unavailable" };
    const key = abrirChaveArtworkMcpExterno(org as never);
    const blogId = Number((org as { mcp_externo_artwork_blog_id?: unknown }).mcp_externo_artwork_blog_id);
    if (!key || !Number.isSafeInteger(blogId) || blogId < 1) return { ok: false, code: "bridge_unconfigured" };

    const { data: message, error: messageError } = await ctx.supabase
      .from("messages")
      .select("id,organization_id,conversation_id,contact_id,direction,media_storage_path,media_mime,media_size_bytes,metadata,revoked_at,created_at")
      .eq("id", input.message_id)
      .eq("organization_id", ctx.organizationId)
      .eq("conversation_id", conversationId)
      .eq("contact_id", contactId)
      .eq("direction", "inbound")
      .is("revoked_at", null)
      .maybeSingle();
    const row = message as {
      id: string; media_storage_path?: string | null; media_mime?: string | null;
      media_size_bytes?: number | null; metadata?: Record<string, unknown> | null;
    } | null;
    if (messageError || !row || !row.media_storage_path || !isMediaPathOwnedBy(row.media_storage_path, ctx.organizationId, conversationId)) {
      return { ok: false, code: "inbound_attachment_not_found" };
    }
    const size = Number(row.media_size_bytes ?? 0);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES) {
      return { ok: false, code: "attachment_size_unsupported" };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);
    const transferId = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(transferId).digest("hex");
    // Best-effort bounded cleanup for expired tickets in this tenant.
    await ctx.supabase.from("mcp_artwork_transfers").delete().eq("organization_id", ctx.organizationId).lt("expires_at", now.toISOString());
    const { error: insertError } = await ctx.supabase.from("mcp_artwork_transfers").insert({
      organization_id: ctx.organizationId,
      token_hash: tokenHash,
      contact_id: contactId,
      conversation_id: conversationId,
      message_id: row.id,
      blog_id: blogId,
      expires_at: expiresAt.toISOString(),
    });
    if (insertError) return { ok: false, code: "transfer_issue_failed" };

    return {
      ok: true,
      transfer_id: transferId,
      expires_at: expiresAt.toISOString(),
      blog_id: blogId,
      media_mime: typeof row.media_mime === "string" ? row.media_mime : null,
      media_size_bytes: size,
    };
  },
};
