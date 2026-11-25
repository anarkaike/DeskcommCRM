import { describe, expect, it } from "vitest";
import { formatTelegramCaseAlertCard } from "./telegram-case-alert-card";

const caseId = "12345678-1234-1234-1234-123456789012";

describe("formatTelegramCaseAlertCard", () => {
  it("shares concise case context without customer identity or transcript", () => {
    const text = formatTelegramCaseAlertCard({
      caseId,
      canal: "WhatsApp",
      titulo: "Pedido de uniforme",
      contexto: "A cliente quer comprar uniforme escolar.",
      bloqueio: "Confirmar a escola e os tamanhos.",
      crmUrl: "https://crm.example/app/ai/cases?caso=abc",
    });
    expect(text).toContain("Caso: 12345678");
    expect(text).toContain("Canal: WhatsApp");
    expect(text).toContain("━━━━ CONTEXTO ━━━━");
    expect(text).toContain("Abrir no CRM:");
    expect(text).not.toContain("ÚLTIMAS MENSAGENS");
    expect(text).not.toContain("Nome do cliente");
  });

  it("bounds untrusted text and the total Telegram message size", () => {
    const text = formatTelegramCaseAlertCard({
      caseId,
      canal: "Telegram",
      titulo: "x".repeat(500),
      contexto: "y".repeat(5000),
      bloqueio: "z".repeat(1000),
      crmUrl: "https://crm.example/case",
    });
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it("redacts phone numbers and email addresses in case summaries", () => {
    const text = formatTelegramCaseAlertCard({
      caseId,
      canal: "WhatsApp",
      titulo: "Pedido para teste@example.com",
      contexto: "Retornar para +55 (34) 99123-4567.",
      bloqueio: null,
      crmUrl: "https://crm.example/case",
    });
    expect(text).toContain("[e-mail omitido]");
    expect(text).toContain("[telefone omitido]");
    expect(text).not.toContain("teste@example.com");
    expect(text).not.toContain("99123-4567");
  });
});
