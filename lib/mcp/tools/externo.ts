/**
 * Ferramentas de um servidor MCP EXTERNO virando tools do turno (#2147).
 *
 * ── Por que elas passam pelo MESMO wrapMcpTool ──────────────────────────────
 *
 * Não existe um caminho paralelo para a ferramenta remota. Ela vira uma
 * `McpToolDefinition` comum — `category: "read"`, `requiresRole: "agent"`,
 * `requiresScope: "mcp:read"` — e é montada pelo mesmo `wrapMcpTool` das
 * compiladas, então herda de graça auditoria (`auditMcpToolCall`), papel,
 * escopo, higiene de uuid de aterro e o tratamento de erro que devolve texto em
 * vez de matar o turno. Um segundo caminho seria uma porta dos fundos onde
 * nada disso valeria.
 *
 * ── Como uma remota é classificada (item 8) ────────────────────────────────
 *
 * Duas metades, e as duas são necessárias:
 *
 * 1. o servidor anuncia `annotations.readOnlyHint === true` (declaração dele,
 *    capturada em `somenteLeitura` por `listarFerramentasDoServidor`);
 * 2. quem administra marcou a ferramenta como LEITURA no `tool_ids` do agente
 *    (`mcp_externo:leitura:<nome>`), que é a escolha do item 6.
 *
 * Só com as duas a ferramenta sai com `category: "read"`. O resto sai como
 * `write`, e uma escrita num turno com contato cai na conferência de escopo de
 * `pickToolsFromMcp` — recusada com `escrita_sem_escopo_do_turno` — em vez de
 * passar por fora dela. `readOnlyHint` sozinho não basta: um servidor que se
 * diga "readOnly" num `cancelar_pedido` estaria escolhendo sozinho atravessar
 * a regra da conversa.
 *
 * ── Por que o nome colide com o compilado e o remoto perde ──────────────────
 *
 * Se o ERP anunciar `crm_search_contacts`, o catálogo COMPILADO continua sendo
 * a fonte daquilo que o produto já sabe fazer: o remoto é descartado com o
 * motivo no log. O inverso — o remoto por cima — seria um servidor alheio
 * se passando por ferramenta interna, e o admin que registrou o endereço não
 * estaria trocando a implementação de um nada.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  chamarFerramentaRemota,
  type FerramentaRemota,
  type OpcoesDeChamada,
} from "@/lib/mcp/servidor-externo/chamada";
import type { EscolhaRemota } from "@/lib/mcp/servidor-externo/ids";
import { hostDoEndpoint, type ServidorMcpExterno } from "@/lib/mcp/servidor-externo/registro";
import type { McpToolDefinition } from "@/lib/mcp/types";
import { logger } from "@/lib/logger";
import { assinarAprovacaoServinder, criarDesafioMutacaoServinder, validarConfirmacaoCotacaoNoHistorico, validarDesafioMutacaoNoHistorico } from "@/lib/mcp/servidor-externo/aprovacao";


const TOOLS_DE_COTACAO_COM_CONFIRMANTE = new Set([
  "servinder_woocommerce_orders_create",
  "servinder_woocommerce_order_items_add",
  "servinder_woocommerce_order_items_update",
  "servinder_woocommerce_order_items_remove",
]);
const TOOLS_COM_APROVACAO_DE_MUTACAO = new Set([
  "servinder_woocommerce_customers_create",
  "servinder_woocommerce_customers_update",
  "servinder_woocommerce_orders_update",
  "servinder_woocommerce_orders_archive",
  "servinder_woocommerce_orders_restore",
]);
interface OpcoesRemotasSeguras extends OpcoesDeChamada {
  supabase?: SupabaseClient; organizationId?: string; contatoDoTurno?: string;
  conversaDoTurno?: string; chaveAprovacao?: string; servidorInterno?: ServidorMcpExterno;
}
function hashSeguro(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
async function autorizarMutacaoGenerica(nome: string, args: Record<string, unknown>, opcoes: OpcoesRemotasSeguras | undefined): Promise<{ assinatura?: string; argumentosRemotos?: Record<string, unknown>; desafio?: { codigo: string; expiraEm: string; textoConfirmacao: string } } | null> {
  if (!TOOLS_COM_APROVACAO_DE_MUTACAO.has(nome)) return null;
  const { supabase, organizationId, contatoDoTurno, conversaDoTurno, chaveAprovacao } = opcoes ?? {};
  if (!supabase || !organizationId || !contatoDoTurno || !conversaDoTurno || !chaveAprovacao) throw new Error("customer_confirmation_unavailable");
  if (typeof args.idempotency_key !== "string" || args.idempotency_key.trim().length < 16) throw new Error("idempotency_key_required");

  const expiraEm = typeof args.approval_expires_at === "string" ? args.approval_expires_at : undefined;
  const desafio = criarDesafioMutacaoServinder({ chave: chaveAprovacao, organizationId, contatoId: contatoDoTurno, conversaId: conversaDoTurno, acao: nome, payload: args, ...(expiraEm ? { expiraEm } : {}) });
  if (args.confirm !== true || args.confirmed_by !== "customer" || typeof args.approval_code !== "string" || !expiraEm) {
    return { desafio };
  }
  if (args.approval_code.toUpperCase() !== desafio.codigo) throw new Error("mutation_approval_payload_mismatch");

  const { data: conversa, error: conversaError } = await supabase.from("conversations").select("id").eq("organization_id", organizationId).eq("id", conversaDoTurno).eq("contact_id", contatoDoTurno).maybeSingle();
  if (conversaError || !conversa) throw new Error("customer_confirmation_conversation_unavailable");
  const { data: rows, error: historyError } = await supabase.from("messages").select("direction,sent_via,body,sent_at,created_at").eq("organization_id", organizationId).eq("conversation_id", conversaDoTurno).eq("contact_id", contatoDoTurno).order("sent_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(500);
  if (historyError || !rows) throw new Error("customer_confirmation_history_unavailable");
  const validation = validarDesafioMutacaoNoHistorico({ chave: chaveAprovacao, organizationId, contatoId: contatoDoTurno, conversaId: conversaDoTurno, acao: nome, payload: args, expiraEm, codigo: args.approval_code, mensagens: [...rows].reverse().map((row) => ({ direction: String(row.direction), sent_via: typeof row.sent_via === "string" ? row.sent_via : null, body: typeof row.body === "string" ? row.body : null, created_at: String(row.sent_at ?? row.created_at ?? "") })) });
  if (!validation.ok) throw new Error(validation.motivo);
  const argumentosRemotos = { ...args };
  delete argumentosRemotos.approval_code;
  delete argumentosRemotos.approval_expires_at;
  if (nome === "servinder_woocommerce_customers_create" || nome === "servinder_woocommerce_customers_update") {
    delete argumentosRemotos.confirm;
    delete argumentosRemotos.confirmed_by;
  }
  return { argumentosRemotos, assinatura: assinarAprovacaoServinder({ chave: chaveAprovacao, contatoId: contatoDoTurno, acao: nome, payload: argumentosRemotos }) };
}

async function autorizarMutacaoDeCotacao(nome: string, args: Record<string, unknown>, opcoes: OpcoesRemotasSeguras | undefined): Promise<string | null> {
  if (!TOOLS_DE_COTACAO_COM_CONFIRMANTE.has(nome)) return null;
  const { supabase, organizationId, contatoDoTurno, conversaDoTurno, chaveAprovacao, servidorInterno } = opcoes ?? {};
  const quoteId = args.quote_id, code = args.confirmation_code, quoteHash = args.confirmation_hash;
  if (args.confirm !== true || args.confirmed_by !== "customer" || typeof args.idempotency_key !== "string" || args.idempotency_key.trim().length < 16) throw new Error("customer_confirmation_fields_invalid");
  if (!supabase || !organizationId || !contatoDoTurno || !conversaDoTurno || !chaveAprovacao || !servidorInterno) throw new Error("customer_confirmation_unavailable");
  if (typeof quoteId !== "string" || !/^[0-9a-f-]{36}$/i.test(quoteId) || typeof code !== "string" || !/^[A-F0-9]{8}$/i.test(code) || !hashSeguro(quoteHash) || code.toUpperCase() !== quoteHash.slice(0, 8).toUpperCase()) throw new Error("quote_confirmation_fields_invalid");
  const { data: conversa, error: conversaError } = await supabase.from("conversations").select("id").eq("organization_id", organizationId).eq("id", conversaDoTurno).eq("contact_id", contatoDoTurno).maybeSingle();
  if (conversaError || !conversa) throw new Error("customer_confirmation_conversation_unavailable");
  const quoteResult = await chamarFerramentaRemota(servidorInterno, "servinder_woocommerce_quote_get", { quote_id: quoteId }, { ...(opcoes?.fetch ? { fetch: opcoes.fetch } : {}), ...(opcoes?.cabecalhos ? { cabecalhos: opcoes.cabecalhos } : {}) });
  const quote = (quoteResult.dados && typeof quoteResult.dados === "object" ? quoteResult.dados : JSON.parse(quoteResult.texto || "{}")) as Record<string, unknown>;
  if (quote.status !== "quoted" || !hashSeguro(quote.confirmation_hash) || quote.confirmation_hash.toLowerCase() !== quoteHash.toLowerCase() || quote.confirmation_code !== code.toUpperCase() || typeof quote.expires_at !== "string" || Date.parse(quote.expires_at) <= Date.now()) throw new Error("quote_not_active_or_confirmation_mismatch");
  const { data: rows, error: historyError } = await supabase.from("messages").select("direction,sent_via,body,sent_at,created_at").eq("organization_id", organizationId).eq("conversation_id", conversaDoTurno).eq("contact_id", contatoDoTurno).order("sent_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(500);
  if (historyError || !rows) throw new Error("customer_confirmation_history_unavailable");
  const validation = validarConfirmacaoCotacaoNoHistorico([...rows].reverse().map((row) => ({ direction: String(row.direction), sent_via: typeof row.sent_via === "string" ? row.sent_via : null, body: typeof row.body === "string" ? row.body : null, created_at: String(row.sent_at ?? row.created_at ?? "") })), code, quote);
  if (!validation.ok) throw new Error(validation.motivo);
  return assinarAprovacaoServinder({ chave: chaveAprovacao, contatoId: contatoDoTurno, acao: nome, payload: args });
}

/**
 * O esqueleto do JSON Schema que o MCP exige (`type: object`) em Zod.
 *
 * Tipos primitivos viram os equivalentes; o resto (objeto aninhado, união,
 * formato) vira `unknown`, que aceita o que o servidor mandar. É de propósito:
 * transformar JSON Schema em Zod em profundidade é um conversor inteiro, e a
 * fatia registra e CHAMA — a validação fina do argumento remoto continua sendo
 * do servidor que conhece o próprio dado. O que não se converte aqui não é
 * recusado, é aceito como está.
 */
function campoZod(bruto: unknown): z.ZodTypeAny {
  const tipo = (bruto as { type?: unknown } | null)?.type;
  switch (tipo) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

function shapeDaFerramenta(ferramenta: FerramentaRemota): Record<string, z.ZodTypeAny> {
  const propriedades = ferramenta.inputSchema?.properties;
  if (!propriedades || typeof propriedades !== "object") return {};
  const exigidos = new Set(ferramenta.inputSchema?.required ?? []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [nome, bruto] of Object.entries(propriedades)) {
    // Nome que não é identificador nunca vira campo: o modelo só consegue
    // escrever o que o esquema nomeia.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(nome)) continue;
    const campo = campoZod(bruto);
    shape[nome] = exigidos.has(nome) ? campo : campo.optional();
  }
  return shape;
}

/**
 * As ferramentas remotas ESCOLHIDAS pelo agente, já convertidas.
 *
 * `nomesOcupados` é o catálogo COMPILADO inteiro (`allTools`), não só o que
 * está montado neste turno: a comparação é "isto já existe no produto?", e
 * quem não foi montado agora continua existindo amanhã.
 *
 * `escolhas` vem de `tool_ids` (`item 6`): sem escolha não há ferramenta
 * remota, mesmo com servidor registrado e anunciando dez (item 7, desligado
 * por padrão). Uma escolha cujo servidor não anuncia mais aquele nome é
 * registrada no log e ignorada — trocar de ERP não pode virar tool fantasma.
 */
export function definirFerramentasRemotas(
  servidor: ServidorMcpExterno,
  ferramentas: readonly FerramentaRemota[],
  nomesOcupados: ReadonlySet<string>,
  escolhas: readonly EscolhaRemota[],
  // JUNTA DE TESTE, mesmo sentido do `fetchImpl` de `allowlistedFetch`: o stub
  // do ERP mora em `127.0.0.1`, faixa que o guard anti-SSRF recusa. Quem chama
  // em produção NÃO passa isto, e a saída é `fetchDeSaida` (item 4).
  opcoes?: OpcoesRemotasSeguras,
): McpToolDefinition[] {
  const definicoes: McpToolDefinition[] = [];
  const anunciadas = new Map(ferramentas.map((f) => [f.name, f]));

  for (const escolha of escolhas) {
    const ferramenta = anunciadas.get(escolha.nome);
    if (!ferramenta) {
      logger.warn("ferramenta remota escolhida pelo agente nao foi anunciada pelo servidor — desconsiderada", {
        endpoint: hostDoEndpoint(servidor.endpoint),
        ferramenta: escolha.nome,
      });
      continue;
    }
    if (nomesOcupados.has(ferramenta.name)) {
      logger.warn("ferramenta do servidor MCP externo colide com o catalogo compilado — mantida a compilada", {
        endpoint: hostDoEndpoint(servidor.endpoint),
        ferramenta: ferramenta.name,
      });
      continue;
    }

    // LEITURA só com as duas metades do item 8 — ver o cabeçalho deste arquivo.
    const ehLeitura = escolha.leitura && ferramenta.somenteLeitura === true;

    definicoes.push({
      name: ferramenta.name,
      // O sufixo diz de ONDE o dado vem: o modelo não pode tratar preço vindo
      // do ERP como se viesse do catálogo do CRM, e o leitor do turno tem o
      // direito de saber que aquilo é consulta a outro sistema.
      description: `${ferramenta.description ?? ferramenta.name} (servidor MCP externo)`,
      inputSchema: shapeDaFerramenta(ferramenta),
      category: ehLeitura ? "read" : "write",
      requiresRole: "agent",
      requiresScope: ehLeitura ? "mcp:read" : "mcp:write",
      handler: async (input) => {
        const argumentos = (input ?? {}) as Record<string, unknown>;
        const autorizacaoGenerica = await autorizarMutacaoGenerica(ferramenta.name, argumentos, opcoes);
        if (autorizacaoGenerica?.desafio) return {
          texto: `Nenhuma alteração foi feita. Mostre literalmente este bloco ao cliente e só chame a mesma ferramenta novamente depois que a última mensagem dele for CONFIRMO ${autorizacaoGenerica.desafio.codigo}:\n${autorizacaoGenerica.desafio.textoConfirmacao}`,
          dados: { status: "customer_confirmation_required", ...autorizacaoGenerica.desafio },
        };
        const assinaturaCotacao = await autorizarMutacaoDeCotacao(ferramenta.name, argumentos, { ...opcoes, servidorInterno: servidor });
        const assinatura = autorizacaoGenerica?.assinatura ?? assinaturaCotacao;
        const argumentosRemotos = autorizacaoGenerica?.argumentosRemotos ?? argumentos;
        const resultado = await chamarFerramentaRemota(servidor, ferramenta.name, argumentosRemotos, {
          ...opcoes,
          ...(assinatura ? { aprovacaoDaChamada: { ferramenta: ferramenta.name, cabecalho: assinatura } } : {}),
        });
        return resultado.dados === undefined
          ? { texto: resultado.texto }
          : { texto: resultado.texto, dados: resultado.dados };
      },
    });
  }

  return definicoes;
}
