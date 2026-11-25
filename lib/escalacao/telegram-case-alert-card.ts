export interface TelegramCaseAlertCardInput {
  caseId: string;
  canal: string | null;
  titulo: string | null;
  contexto: string | null;
  bloqueio: string | null;
  crmUrl: string;
}

function redactPersonalData(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[e-mail omitido]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (match) =>
      match.replace(/\D/g, "").length >= 8 ? "[telefone omitido]" : match,
    );
}

function textoCurto(
  value: string | null | undefined,
  max: number,
  vazio = "Não informado",
): string {
  const clean = redactPersonalData(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return vazio;
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

function nomeDoCanal(value: string | null): string {
  const key = (value ?? "").trim().toLocaleLowerCase("pt-BR");
  const labels: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    instagram: "Instagram",
    facebook: "Facebook",
    messenger: "Facebook Messenger",
  };
  return labels[key] ?? textoCurto(value, 50, "Canal não identificado");
}

export function formatTelegramCaseAlertCard(input: TelegramCaseAlertCardInput): string {
  const lines = [
    "🆘 APOIO DA EQUIPE",
    "━━━━━━━━━━━━━━━━━━",
    `Caso: ${input.caseId.slice(0, 8)}`,
    `Canal: ${nomeDoCanal(input.canal)}`,
    "",
    "━━━━━━━━ CONTEXTO ━━━━━━━━",
    textoCurto(input.titulo, 140, "Atendimento precisa de apoio"),
    textoCurto(input.contexto, 500, "O resumo do atendimento não está disponível."),
    input.bloqueio ? `Precisa de ajuda: ${textoCurto(input.bloqueio, 240)}` : "",
  ];
  lines.push("", "━━━━━━━━━━━━━━━━━━", "Abrir no CRM:", input.crmUrl);
  const card = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return card.length <= 4000 ? card : `${card.slice(0, 3997).trimEnd()}…`;
}
