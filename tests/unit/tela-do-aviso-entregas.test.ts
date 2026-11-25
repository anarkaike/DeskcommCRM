import { describe, expect, it } from "vitest";

import { normalizarStatusDeEntregaTelegram } from "@/lib/escalacao/tela-do-aviso";

describe("normalizarStatusDeEntregaTelegram", () => {
  it.each([
    ["pending", "pendente"],
    ["sending", "pendente"],
    ["sent", "enviado"],
    ["failed", "falhou"],
    ["cancelled", "cancelado"],
  ])("mapeia %s para o estado comum da tela", (status, esperado) => {
    expect(normalizarStatusDeEntregaTelegram(status)).toBe(esperado);
  });

  it("preserva estados futuros desconhecidos para manter visibilidade", () => {
    expect(normalizarStatusDeEntregaTelegram("future_state")).toBe("future_state");
  });
});

describe("primeiroEnvioDeAviso", () => {
  it("escolhe o envio mais antigo entre WhatsApp e Telegram por caso", async () => {
    const { primeiroEnvioDeAviso } = await import("@/lib/escalacao/tela-do-aviso");
    const resultado = primeiroEnvioDeAviso(
      [{ case_id: "caso-1", enviado_em: "2026-10-28T12:00:00.000Z" }],
      [{ case_id: "caso-1", sent_at: "2026-10-28T11:00:00.000Z" }],
    );
    expect(resultado.get("caso-1")).toBe("2026-10-28T11:00:00.000Z");
  });

  it("ignora timestamps ausentes e compara por caso", async () => {
    const { primeiroEnvioDeAviso } = await import("@/lib/escalacao/tela-do-aviso");
    const resultado = primeiroEnvioDeAviso(
      [{ case_id: "caso-1", enviado_em: null }],
      [{ case_id: "caso-2", sent_at: "2026-10-28T11:00:00.000Z" }],
    );
    expect(resultado.get("caso-1")).toBeUndefined();
    expect(resultado.get("caso-2")).toBe("2026-10-28T11:00:00.000Z");
  });
});
