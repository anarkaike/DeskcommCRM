import { createHash, createHmac } from "node:crypto";

export interface EntradaAssinaturaServinder {
  chave: string;
  contatoId: string;
  acao: string;
  payload: Record<string, unknown>;
  timestamp?: number;
}

function serializarCanonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(serializarCanonico).join(",")}]`;
  if (typeof valor === "object" && valor !== null) {
    const entradas = Object.entries(valor as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entradas.map(([chave, filho]) => `${JSON.stringify(chave)}:${serializarCanonico(filho)}`).join(",")}}`;
  }
  const serializado = JSON.stringify(valor);
  if (serializado === undefined) throw new Error("approval_payload_invalid");
  return serializado;
}

/** JSON canônico compatível com wp_json_encode(…, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES). */
export function jsonCanonicoServinder(payload: Record<string, unknown>): string {
  return serializarCanonico(payload);
}

export function assinarAprovacaoServinder(entrada: EntradaAssinaturaServinder): string {
  if (entrada.chave.length < 32) throw new Error("approval_key_unavailable");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entrada.contatoId)) {
    throw new Error("approval_contact_invalid");
  }
  const timestamp = entrada.timestamp ?? Math.floor(Date.now() / 1000);
  const digest = createHash("sha256").update(jsonCanonicoServinder(entrada.payload), "utf8").digest("hex");
  const material = `${entrada.contatoId.toLowerCase()}\n${entrada.acao}\n${digest}\n${timestamp}`;
  const signature = createHmac("sha256", entrada.chave).update(material, "utf8").digest("hex");
  return `${timestamp}.${signature}`;
}

export interface MensagemConfirmacao {
  direction: string;
  sent_via: string | null;
  body: string | null;
  created_at: string;
}

/** Dados comerciais mínimos que precisam ter sido mostrados ao cliente antes da confirmação. */
export interface ResumoCotacaoConfirmavel {
  currency?: unknown;
  items?: unknown;
  total_excluding_shipping?: unknown;
  shipping_status?: unknown;
}

function normalizarTextoConfirmacao(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
}

function contemQuantidade(texto: string, quantidade: number): boolean {
  return new RegExp(`(?:^|\\D)${quantidade}(?:$|\\D)`).test(texto);
}

function variantesValor(valor: unknown): string[] {
  const numero = typeof valor === "number" ? valor : typeof valor === "string" && valor.trim() ? Number(valor.replace(",", ".")) : NaN;
  if (!Number.isFinite(numero)) return [];
  const fixo = numero.toFixed(2);
  return [...new Set([fixo, fixo.replace(".", ","), fixo.replace(/\.00$/, "")])].map(normalizarTextoConfirmacao);
}

function valoresDeConfiguracao(value: unknown, key = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((child) => valoresDeConfiguracao(child, key));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) =>
      /(?:^|_)(?:id|ids|artwork|token|url)(?:$|_)/i.test(childKey) ? [] : valoresDeConfiguracao(child, childKey),
    );
  }
  if (typeof value === "string" && value.trim() && !/(?:^|_)(?:id|ids|token|url)(?:$|_)/i.test(key)) return [normalizarTextoConfirmacao(value.trim())];
  if (typeof value === "number" && /^(?:normal|baby-look|quantity|size|tamanho)$/i.test(key)) return [String(value)];
  return [];
}

/**
 * Confere que a última mensagem do cliente confirma literalmente a cotação e que,
 * antes dela, uma mensagem da IA apresentou código, itens, quantidades, valores,
 * moeda, total e eventual aviso de frete pendente.
 */
export function validarConfirmacaoCotacaoNoHistorico(
  mensagens: readonly MensagemConfirmacao[],
  codigo: string,
  cotacao: ResumoCotacaoConfirmavel,
): { ok: true } | { ok: false; motivo: string } {
  if (!/^[A-F0-9]{8}$/i.test(codigo)) return { ok: false, motivo: "confirmation_code_invalid" };
  const ultima = mensagens.at(-1);
  if (!ultima || ultima.direction !== "inbound" || (ultima.body ?? "").trim().toUpperCase() !== `CONFIRMO ${codigo.toUpperCase()}`) {
    return { ok: false, motivo: "customer_confirmation_not_latest" };
  }
  const mensagensDaIa = mensagens.slice(0, -1).filter((m) => m.direction === "outbound" && m.sent_via === "ai");
  const apresentacao = normalizarTextoConfirmacao(mensagensDaIa.map((m) => m.body ?? "").join("\n"));
  const codigoEscapado = codigo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regexCodigo = new RegExp(`(?:^|[^A-Z0-9])${codigoEscapado}(?:$|[^A-Z0-9])`, "i");
  if (!mensagensDaIa.some((m) => regexCodigo.test(m.body ?? ""))) return { ok: false, motivo: "quote_code_not_presented_by_ai" };
  if (!Array.isArray(cotacao.items) || cotacao.items.length === 0) return { ok: false, motivo: "quote_summary_unavailable" };
  for (const bruto of cotacao.items) {
    if (!bruto || typeof bruto !== "object") return { ok: false, motivo: "quote_summary_unavailable" };
    const item = bruto as Record<string, unknown>;
    const nome = typeof item.name === "string" ? normalizarTextoConfirmacao(item.name.trim()) : "";
    const quantidade = Number(item.quantity);
    if (!nome || !Number.isInteger(quantidade) || quantidade < 1 || !apresentacao.includes(nome) || !contemQuantidade(apresentacao, quantidade)) {
      return { ok: false, motivo: "quote_items_not_presented_by_ai" };
    }
    const valores = variantesValor(item.total);
    if (!valores.length || !valores.some((v) => apresentacao.includes(v))) return { ok: false, motivo: "quote_item_prices_not_presented_by_ai" };
    const escolhas = [
      ...valoresDeConfiguracao(item.configuration),
      ...(Array.isArray(item.variation) ? item.variation.flatMap((choice) =>
        choice && typeof choice === "object" ? valoresDeConfiguracao(choice) : [],
      ) : []),
    ].filter((choice) => choice.length >= 2);
    if (escolhas.some((choice) => !apresentacao.includes(choice))) return { ok: false, motivo: "quote_configuration_not_presented_by_ai" };
  }
  const total = variantesValor(cotacao.total_excluding_shipping);
  if (!total.length || !total.some((v) => apresentacao.includes(v))) return { ok: false, motivo: "quote_total_not_presented_by_ai" };
  const moeda = typeof cotacao.currency === "string" ? normalizarTextoConfirmacao(cotacao.currency) : "";
  if (!(moeda && apresentacao.includes(moeda)) && !(moeda === "brl" && /r\$|reais/.test(apresentacao))) return { ok: false, motivo: "quote_currency_not_presented_by_ai" };
  if (cotacao.shipping_status === "not_calculated" && !/(frete[^.\n]{0,50}(nao calculado|pendente|a calcular)|nao inclui frete|frete sera calculado)/.test(apresentacao)) {
    return { ok: false, motivo: "quote_shipping_status_not_presented_by_ai" };
  }
  return { ok: true };
}

export interface EntradaDesafioMutacaoServinder {
  chave: string;
  organizationId: string;
  contatoId: string;
  conversaId: string;
  acao: string;
  payload: Record<string, unknown>;
  expiraEm?: string;
}

function payloadDaMutacao(payload: Record<string, unknown>): Record<string, unknown> {
  const reservado = new Set(["confirm", "confirmed_by", "approval_code", "approval_expires_at"]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !reservado.has(key)));
}

/** Challenge curto vinculado ao tenant, contato, conversa, tool e payload comercial exato. */
export function criarDesafioMutacaoServinder(entrada: EntradaDesafioMutacaoServinder): {
  codigo: string;
  expiraEm: string;
  textoConfirmacao: string;
} {
  if (entrada.chave.length < 32) throw new Error("approval_key_unavailable");
  const expiraEm = entrada.expiraEm ?? new Date(Date.now() + 5 * 60_000).toISOString();
  const json = jsonCanonicoServinder(payloadDaMutacao(entrada.payload));
  const hash = createHash("sha256").update(json, "utf8").digest("hex");
  const material = [entrada.organizationId, entrada.contatoId.toLowerCase(), entrada.conversaId, entrada.acao, hash, expiraEm].join("\n");
  const codigo = createHmac("sha256", entrada.chave).update(material, "utf8").digest("hex").slice(0, 12).toUpperCase();
  const textoConfirmacao = `AÇÃO ${entrada.acao}\nDADOS ${json}\nEXPIRA ${expiraEm}\nRESPONDA EXATAMENTE: CONFIRMO ${codigo}`;
  return { codigo, expiraEm, textoConfirmacao };
}

/** Verifica desafio não expirado e prova literal de exibição/aceite no histórico da conversa. */
export function validarDesafioMutacaoNoHistorico(
  entrada: EntradaDesafioMutacaoServinder & { codigo: string; mensagens: readonly MensagemConfirmacao[]; agora?: number },
): { ok: true } | { ok: false; motivo: string } {
  const expiraMs = Date.parse(entrada.expiraEm ?? "");
  const agora = entrada.agora ?? Date.now();
  if (!/^[A-F0-9]{12}$/i.test(entrada.codigo) || !Number.isFinite(expiraMs) || expiraMs <= agora || expiraMs > agora + 5 * 60_000 + 5_000) {
    return { ok: false, motivo: "mutation_approval_expired_or_invalid" };
  }
  const desafio = criarDesafioMutacaoServinder(entrada);
  if (desafio.codigo !== entrada.codigo.toUpperCase()) return { ok: false, motivo: "mutation_approval_payload_mismatch" };
  const ultima = entrada.mensagens.at(-1);
  if (!ultima || ultima.direction !== "inbound" || (ultima.body ?? "").trim().toUpperCase() !== `CONFIRMO ${entrada.codigo.toUpperCase()}`) {
    return { ok: false, motivo: "customer_confirmation_not_latest" };
  }
  const exibiuTextoExato = entrada.mensagens.slice(0, -1).some((mensagem) =>
    mensagem.direction === "outbound" && mensagem.sent_via === "ai" && (mensagem.body ?? "").includes(desafio.textoConfirmacao),
  );
  return exibiuTextoExato ? { ok: true } : { ok: false, motivo: "mutation_summary_not_presented_by_ai" };
}
