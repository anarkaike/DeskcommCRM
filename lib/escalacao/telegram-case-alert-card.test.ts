import { describe, expect, it } from "vitest";
import { formatTelegramCaseAlertCard } from "./telegram-case-alert-card";

describe("formatTelegramCaseAlertCard", () => {
  it("contains concise case context without customer identity or conversation transcript", () => {
    const text = formatTelegramCaseAlertCard({
      caseId: "22222222-3333-4333-8333-555555555555",
      canal: "WhatsApp",
      titulo: "Pedido de uniforme",
      contexto: "A cliente quer comprar uniforme escolar.",
      bloqueio: "Confirmar a escola e os tamanhos.",
      crmUrl: "https://crm.example/app/ai/cases?caso=abc",
    });
    expect(text).toContain("Caso: 22222222");
    expect(text).toContain("Canal: WhatsApp");
    expect(text).toContain("CONTEXTO");
    expect(text).toContain("Abrir no CRM:");
    expect(text).not.toContain("Raissa de Almeida");
    expect(text).not.toContain("5534991234567");
    expect(text).not.toContain("Qual o preço?");
  });

  it("redacts personal data and bounds untrusted text and total message size", () => {
    const text = formatTelegramCaseAlertCard({
      caseId: "33333333-3333-4333-8333-555555555555",
      canal: "Telegram",
      titulo: "x".repeat(500),
      contexto: "Contato julia@example.com, telefone +55 (34) 99123-4567. " + "y".repeat(5000),
      bloqueio: "z".repeat(1000),
      crmUrl: "https://crm.example/case",
    });
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("[e-mail omitido]");
    expect(text).toContain("[telefone omitido]");
    expect(text).not.toContain("julia@example.com");
    expect(text).not.toContain("99123-4567");
  });
});
