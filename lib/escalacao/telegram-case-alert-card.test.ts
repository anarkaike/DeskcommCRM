import { describe, expect, it } from "vitest";
import { formatTelegramCaseAlertCard } from "./telegram-case-alert-card";

describe("formatTelegramCaseAlertCard", () => {
  it("organizes only the useful case context and masks phone digits", () => {
    const text = formatTelegramCaseAlertCard({
      cliente: "Raissa de Almeida",
      agente: "Vendedor IA",
      roteador: "Vendas",
      canal: "WhatsApp",
      telefone: "+5534991234567",
      titulo: "Pedido de uniforme",
      contexto: "A cliente quer comprar uniforme escolar.",
      bloqueio: "Confirmar a escola e os tamanhos.",
      mensagens: [
        { direction: "inbound", sent_via: "crm", body: "Qual o preço?" },
        { direction: "outbound", sent_via: "ai", body: "Vou verificar." },
      ],
      crmUrl: "https://crm.example/app/ai/cases?caso=abc",
    });
    expect(text).toContain("Cliente: Raissa de Almeida");
    expect(text).toContain("Agente: Vendedor IA");
    expect(text).toContain("Roteador: Vendas");
    expect(text).toContain("Canal: WhatsApp · telefone final 4567");
    expect(text).toContain("━━━━ CONTEXTO ━━━━");
    expect(text).toContain("ÚLTIMAS MENSAGENS");
    expect(text).toContain("Cliente: Qual o preço?");
    expect(text).toContain("IA: Vou verificar.");
    expect(text).toContain("Abrir no CRM:");
    expect(text).not.toContain("5534991234567");
  });

  it("bounds untrusted text and the total Telegram message size", () => {
    const text = formatTelegramCaseAlertCard({
      cliente: "Cliente",
      agente: null,
      roteador: null,
      canal: "Telegram",
      telefone: null,
      titulo: "x".repeat(500),
      contexto: "y".repeat(5000),
      bloqueio: "z".repeat(1000),
      mensagens: Array.from({ length: 8 }, (_, i) => ({
        direction: i % 2 ? "outbound" : "inbound",
        sent_via: "ai",
        body: "m".repeat(1000),
      })),
      crmUrl: "https://crm.example/case",
    });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("Roteador: Sem roteador associado");
  });
});
