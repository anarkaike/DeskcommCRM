import { createHmac, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assinarAprovacaoServinder, criarDesafioMutacaoServinder, jsonCanonicoServinder, validarConfirmacaoCotacaoNoHistorico, validarDesafioMutacaoNoHistorico } from "./aprovacao";

describe("aprovacao Servinder WooCommerce", () => {
  it("assina payload canônico compatível com o contrato WordPress", () => {
    const payload = { z: "á/é", nested: { b: 2, a: 1 }, items: [{ id: 2 }, { id: 1 }] };
    const canonical = jsonCanonicoServinder(payload);
    expect(canonical).toBe('{"items":[{"id":2},{"id":1}],"nested":{"a":1,"b":2},"z":"á/é"}');
    expect(jsonCanonicoServinder({ "2": "dois", "10": "dez" })).toBe('{"10":"dez","2":"dois"}');
    const timestamp = 1793030000;
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    const material = `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nservinder_woocommerce_orders_create\n${digest}\n${timestamp}`;
    const expected = createHmac("sha256", "approval-secret-at-least-32-characters").update(material).digest("hex");
    expect(assinarAprovacaoServinder({
      chave: "approval-secret-at-least-32-characters",
      contatoId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      acao: "servinder_woocommerce_orders_create",
      payload,
      timestamp,
    })).toBe(`${timestamp}.${expected}`);
  });

  it("vincula confirmação de mutação ao payload, tenant, contato, conversa e texto exato", () => {
    const entrada = {
      chave: "approval-secret-at-least-32-characters",
      organizationId: "org-disk-uniformes",
      contatoId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      conversaId: "conversa-1",
      acao: "servinder_woocommerce_customers_update",
      payload: { customer_id: 21, first_name: "Junio", idempotency_key: "customer-update-key-0001", confirm: true, confirmed_by: "customer" },
    };
    const expiraEm = new Date(Date.now() + 60_000).toISOString();
    const desafio = criarDesafioMutacaoServinder({ ...entrada, expiraEm });
    expect(desafio.codigo).toMatch(/^[A-F0-9]{12}$/);
    const mensagens = [
      { direction: "outbound", sent_via: "ai", body: desafio.textoConfirmacao, created_at: new Date().toISOString() },
      { direction: "inbound", sent_via: null, body: `CONFIRMO ${desafio.codigo}`, created_at: new Date().toISOString() },
    ];
    expect(validarDesafioMutacaoNoHistorico({ ...entrada, expiraEm, codigo: desafio.codigo, mensagens })).toEqual({ ok: true });
    expect(validarDesafioMutacaoNoHistorico({ ...entrada, payload: { ...entrada.payload, first_name: "Alterado" }, expiraEm, codigo: desafio.codigo, mensagens })).toEqual({ ok: false, motivo: "mutation_approval_payload_mismatch" });
    expect(validarDesafioMutacaoNoHistorico({ ...entrada, expiraEm: new Date(Date.now() - 1000).toISOString(), codigo: desafio.codigo, mensagens })).toEqual({ ok: false, motivo: "mutation_approval_expired_or_invalid" });
    expect(validarDesafioMutacaoNoHistorico({ ...entrada, expiraEm, codigo: desafio.codigo, mensagens: [
      { ...mensagens[0]!, sent_via: "operator" }, mensagens[1]!,
    ] })).toEqual({ ok: false, motivo: "mutation_summary_not_presented_by_ai" });
  });

  it("exige que a IA apresente resumo material da cotação antes da confirmação literal", () => {
    const cotacao = {
      currency: "USD",
      items: [{ name: "Uniforme Escolar", quantity: 2, total: "40.00", configuration: { school: "Escola Municipal Horizonte", model: "Kit Completo", cuts: { normal: 1, "baby-look": 1 } }, variation: [{ label: "Tamanho", value: "M" }] }],
      total_excluding_shipping: "50.00",
      shipping_status: "not_calculated",
    };
    const resumo = "Uniforme Escolar, Escola Municipal Horizonte, modelo Kit Completo, tamanho M, 2 unidades (1 corte normal e 1 baby-look): USD 40.00. Total USD 50.00. Frete não calculado. Código ABCD1234. Responda CONFIRMO ABCD1234.";
    const mensagens = [
      { direction: "outbound", sent_via: "ai", body: resumo, created_at: "2026-10-26T12:00:00Z" },
      { direction: "inbound", sent_via: null, body: "CONFIRMO ABCD1234", created_at: "2026-10-26T12:01:00Z" },
    ];
    expect(validarConfirmacaoCotacaoNoHistorico(mensagens, "ABCD1234", cotacao)).toEqual({ ok: true });
    expect(validarConfirmacaoCotacaoNoHistorico([...mensagens, { direction: "inbound", sent_via: null, body: "Cancela", created_at: "2026-10-26T12:02:00Z" }], "ABCD1234", cotacao))
      .toEqual({ ok: false, motivo: "customer_confirmation_not_latest" });
    expect(validarConfirmacaoCotacaoNoHistorico([
      { direction: "outbound", sent_via: "ai", body: "Confirme com ABCD1234", created_at: "2026-10-26T12:00:00Z" }, mensagens[1]!,
    ], "ABCD1234", cotacao)).toEqual({ ok: false, motivo: "quote_items_not_presented_by_ai" });
    expect(validarConfirmacaoCotacaoNoHistorico([
      { direction: "outbound", sent_via: "operator", body: resumo, created_at: "2026-10-26T12:00:00Z" }, mensagens[1]!,
    ], "ABCD1234", cotacao)).toEqual({ ok: false, motivo: "quote_code_not_presented_by_ai" });
    expect(validarConfirmacaoCotacaoNoHistorico([
      { ...mensagens[0]!, body: resumo.replace("40.00", "99.00") }, mensagens[1]!,
    ], "ABCD1234", cotacao)).toEqual({ ok: false, motivo: "quote_item_prices_not_presented_by_ai" });
    expect(validarConfirmacaoCotacaoNoHistorico([
      { ...mensagens[0]!, body: resumo.replace("Frete não calculado.", "Frete incluso.") }, mensagens[1]!,
    ], "ABCD1234", cotacao)).toEqual({ ok: false, motivo: "quote_shipping_status_not_presented_by_ai" });
    expect(validarConfirmacaoCotacaoNoHistorico([
      { ...mensagens[0]!, body: resumo.replace("Escola Municipal Horizonte", "") }, mensagens[1]!,
    ], "ABCD1234", cotacao)).toEqual({ ok: false, motivo: "quote_configuration_not_presented_by_ai" });
  });
});
