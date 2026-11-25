export interface TelegramCaseAlertCardInput {
  cliente: string | null;
  agente: string | null;
  roteador: string | null;
  canal: string | null;
  telefone: string | null;
  titulo: string | null;
  contexto: string | null;
  bloqueio: string | null;
  mensagens: Array<{ direction: string; sent_via: string; body: string }>;
  crmUrl: string;
}

function textoCurto(
  value: string | null | undefined,
  max: number,
  vazio = "Não informado",
): string {
  const clean = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return vazio;
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

function mascaraTelefone(value: string | null): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length < 8 ? null : `final ${digits.slice(-4)}`;
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
  const telefone = mascaraTelefone(input.telefone);
  const lines = [
    "🆘 APOIO DA EQUIPE",
    "━━━━━━━━━━━━━━━━━━",
    `Cliente: ${textoCurto(input.cliente, 100, "Cliente não identificado")}`,
    `Agente: ${textoCurto(input.agente, 80, "Equipe de atendimento")}`,
    `Roteador: ${textoCurto(input.roteador, 80, "Sem roteador associado")}`,
    `Canal: ${nomeDoCanal(input.canal)}${telefone ? ` · telefone ${telefone}` : ""}`,
    "",
    "━━━━━━━━ CONTEXTO ━━━━━━━━",
    textoCurto(input.titulo, 140, "Atendimento precisa de apoio"),
    textoCurto(input.contexto, 500, "O resumo do atendimento não está disponível."),
    input.bloqueio ? `Precisa de ajuda: ${textoCurto(input.bloqueio, 240)}` : "",
    "",
    "━━━━ ÚLTIMAS MENSAGENS ━━━━",
  ];
  const mensagens = input.mensagens.slice(-4);
  if (!mensagens.length) lines.push("Ainda não há mensagens de texto para exibir.");
  for (const message of mensagens) {
    const autor =
      message.direction === "inbound" ? "Cliente" : message.sent_via === "ai" ? "IA" : "Equipe";
    lines.push(`${autor}: ${textoCurto(message.body, 350)}`);
  }
  lines.push("", "━━━━━━━━━━━━━━━━━━", "Abrir no CRM:", input.crmUrl);
  const card = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return card.length <= 4000 ? card : `${card.slice(0, 3997).trimEnd()}…`;
}
