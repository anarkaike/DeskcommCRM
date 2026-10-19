"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { Bell, ChatCircle, Gear, PaperPlaneTilt, Plus, Robot, UsersThree } from "@/lib/ui/icons";

type Surface = "inbox" | "team_alerts" | "human_cases" | "agent_tools" | "mini_app";
type Binding = { surface: Surface; capabilities: string[] };
type Bot = {
  id: string;
  telegram_bot_id: string;
  bot_username: string | null;
  display_name: string;
  token_last4: string;
  status: "draft" | "configured" | "active" | "paused" | "disconnected" | "error";
  created_at: string;
  bindings: Binding[];
};
type ApiEnvelope<T> = { data: T };
type CapabilityOption = { key: string; title: string; detail: string; defaultOn?: boolean };
type SurfaceOption = {
  key: Surface;
  title: string;
  detail: string;
  icon: typeof ChatCircle;
  capabilities: CapabilityOption[];
};

const SURFACES: SurfaceOption[] = [
  {
    key: "inbox",
    title: "Atendimento na Inbox",
    detail: "Receber mensagens e permitir respostas humanas.",
    icon: ChatCircle,
    capabilities: [
      {
        key: "receive_messages",
        title: "Receber mensagens",
        detail: "Abrir conversas recebidas no CRM.",
        defaultOn: true,
      },
      {
        key: "human_replies",
        title: "Respostas humanas",
        detail: "Permitir que atendentes respondam por este bot.",
        defaultOn: true,
      },
      {
        key: "ai_replies",
        title: "Respostas automáticas de IA",
        detail: "A IA poderá enviar respostas neste canal.",
      },
      {
        key: "proactive_send",
        title: "Envio proativo",
        detail: "Permitir mensagens iniciadas pela equipe ou automações.",
      },
      {
        key: "group_messages",
        title: "Mensagens em grupos",
        detail: "Incluir grupos e comunidades no atendimento.",
      },
    ],
  },
  {
    key: "team_alerts",
    title: "Avisos da equipe",
    detail: "Reservar este bot para notificações internas.",
    icon: Bell,
    capabilities: [
      {
        key: "send_alerts",
        title: "Enviar avisos",
        detail: "A equipe poderá receber notificações por este bot.",
        defaultOn: true,
      },
    ],
  },
  {
    key: "human_cases",
    title: "Casos humanos",
    detail: "Relacionar conversas ao fluxo de casos da equipe.",
    icon: UsersThree,
    capabilities: [
      {
        key: "read_cases",
        title: "Consultar casos",
        detail: "Permitir leitura de casos conforme o acesso do usuário.",
        defaultOn: true,
      },
      {
        key: "reply_to_cases",
        title: "Responder casos",
        detail: "Permitir respostas humanas em casos vinculados.",
      },
    ],
  },
  {
    key: "agent_tools",
    title: "Ferramentas de agente",
    detail: "Conceder ferramentas explicitamente a agentes de IA.",
    icon: Robot,
    capabilities: [
      {
        key: "tool_read",
        title: "Ferramentas de leitura",
        detail: "Agentes poderão consultar recursos Telegram autorizados.",
        defaultOn: true,
      },
      {
        key: "tool_write",
        title: "Ferramentas de escrita",
        detail: "Agentes poderão executar ações de escrita autorizadas.",
      },
    ],
  },
  {
    key: "mini_app",
    title: "Mini App ou portal do cliente",
    detail: "Associar o bot a uma experiência web dentro do Telegram.",
    icon: PaperPlaneTilt,
    capabilities: [
      {
        key: "mini_app_access",
        title: "Abrir Mini App",
        detail: "Permitir acesso à aplicação web Telegram deste tenant.",
        defaultOn: true,
      },
    ],
  },
];

type Selection = Record<Surface, string[]>;

function padraoInicial(): Selection {
  return {
    inbox: ["receive_messages", "human_replies"],
    team_alerts: [],
    human_cases: [],
    agent_tools: [],
    mini_app: [],
  };
}

function selecaoDe(bindings: Binding[]): Selection {
  const selection = padraoInicial();
  for (const surface of SURFACES) {
    selection[surface.key] =
      bindings.find((binding) => binding.surface === surface.key)?.capabilities ?? [];
  }
  return selection;
}

export function TelegramConnectionsClient() {
  const t = useT();
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [lifecycleConnectionId, setLifecycleConnectionId] = useState<string | null>(null);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [selection, setSelection] = useState<Selection>(padraoInicial);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fetchBots = useCallback(
    () => apiClient.get<ApiEnvelope<{ bots: Bot[] }>>("/api/v1/channels/telegram"),
    [],
  );

  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      try {
        const response = await fetchBots();
        setBots(response.data.bots);
      } catch {
        toast.error(t("Não foi possível carregar as conexões Telegram."));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [fetchBots, t],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchBots()
      .then((response) => {
        if (!cancelled) setBots(response.data.bots);
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(t("Não foi possível carregar as conexões Telegram."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchBots, t]);

  const configuredCount = useMemo(
    () => bots.filter((bot) => bot.status === "configured").length,
    [bots],
  );
  const selectedSurfaceCount = useMemo(
    () => bots.reduce((count, bot) => count + bot.bindings.length, 0),
    [bots],
  );

  function editSettings(bot: Bot) {
    setSelectedBot(bot);
    setSelection(selecaoDe(bot.bindings));
    setSettingsOpen(true);
  }

  async function addBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnecting(true);
    try {
      const response = await apiClient.post<ApiEnvelope<{ bot: Bot }>>(
        "/api/v1/channels/telegram",
        {
          display_name: name,
          token,
        },
      );
      const created = { ...response.data.bot, bindings: [] };
      setBots((current) => [created, ...current]);
      setName("");
      setToken("");
      setSelectedBot(created);
      setSelection(padraoInicial());
      setSettingsOpen(true);
      toast.success(t("Token validado e conexão registrada. Configure os usos deste bot."));
    } catch {
      toast.error(t("Não foi possível validar ou registrar o bot."));
    } finally {
      setConnecting(false);
    }
  }

  function setSurfaceEnabled(surface: Surface, enabled: boolean) {
    setSelection((current) => ({
      ...current,
      [surface]: enabled
        ? current[surface].length > 0
          ? current[surface]
          : (SURFACES.find((item) => item.key === surface)
              ?.capabilities.filter((capability) => capability.defaultOn)
              .map((capability) => capability.key) ?? [])
        : [],
    }));
  }

  function toggleCapability(surface: Surface, capability: string, enabled: boolean) {
    setSelection((current) => ({
      ...current,
      [surface]: enabled
        ? Array.from(new Set([...current[surface], capability]))
        : current[surface].filter((item) => item !== capability),
    }));
  }

  async function saveSettings() {
    if (!selectedBot) return;
    setSavingSettings(true);
    try {
      const bindings = SURFACES.flatMap((surface) => {
        const capabilities = selection[surface.key];
        return capabilities.length ? [{ surface: surface.key, capabilities }] : [];
      });
      await apiClient.patch("/api/v1/channels/telegram", {
        connection_id: selectedBot.id,
        bindings,
      });
      toast.success(t("Usos e capacidades salvos."));
      setSettingsOpen(false);
      await load(true);
    } catch {
      toast.error(t("Não foi possível salvar as configurações do bot."));
    } finally {
      setSavingSettings(false);
    }
  }

  async function runLifecycle(bot: Bot, action: "activate" | "pause" | "reactivate" | "disconnect" | "delete") {
    if (action === "delete" && !window.confirm(t("Excluir este bot e remover seu webhook do Telegram?"))) return;
    setLifecycleConnectionId(bot.id);
    try {
      await apiClient.patch("/api/v1/channels/telegram", { action, connection_id: bot.id });
      toast.success(t({
        activate: "Bot ativado e webhook registrado.",
        reactivate: "Bot reativado e webhook registrado.",
        pause: "Bot pausado; updates pendentes foram preservados.",
        disconnect: "Bot desconectado do Telegram; o cadastro foi preservado.",
        delete: "Bot excluído e webhook removido.",
      }[action]));
      await load(true);
    } catch {
      toast.error(t("Não foi possível alterar o estado do bot Telegram."));
    } finally {
      setLifecycleConnectionId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="telegram-connections">
      <Card className="overflow-hidden border-accent/20 bg-gradient-to-r from-accent-soft via-surface to-surface p-5 md:p-7">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-14 items-center justify-center rounded-xl bg-accent text-accent-foreground shadow-sm">
            <PaperPlaneTilt size={27} weight="fill" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-[0.14em] text-accent uppercase">
              {t("Integrações · conexões")}
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-text md:text-2xl">
              Telegram
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">
              {t("Conecte bots independentes e escolha onde cada um poderá ser usado.")}
            </p>
          </div>
          <Badge variant="outline">{t("Tokens protegidos no servidor")}</Badge>
        </div>
      </Card>

      <div className="grid gap-3 md:grid-cols-3">
        <Stat
          label={t("Bots cadastrados")}
          value={String(bots.length).padStart(2, "0")}
          detail={t("Tokens validados")}
        />
        <Stat
          label={t("Configurações salvas")}
          value={String(configuredCount).padStart(2, "0")}
          detail={t("Nenhum bot recebe mensagens ainda")}
        />
        <Stat
          label={t("Usos associados")}
          value={String(selectedSurfaceCount).padStart(2, "0")}
          detail={t("Preferências por conexão")}
        />
      </div>

      <Card className="p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-[0.14em] text-accent uppercase">
              {t("Conexões e permissões")}
            </p>
            <h3 className="mt-1 text-lg font-semibold text-text">{t("Bots desta organização")}</h3>
            <p className="mt-1 text-sm text-text-muted">
              {t("Cada bot tem credencial e usos configurados separadamente.")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? t("Atualizando…") : t("Atualizar")}
          </Button>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.75fr)]">
          <div className="flex min-h-56 flex-col gap-3 rounded-lg border border-border p-3 md:p-4">
            <h4 className="font-medium text-text">{t("Conexões cadastradas")}</h4>
            {loading ? (
              <p className="py-10 text-center text-sm text-text-muted">
                {t("Carregando conexões…")}
              </p>
            ) : bots.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-10 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
                  <PaperPlaneTilt size={22} aria-hidden="true" />
                </div>
                <h5 className="mt-3 font-semibold text-text">{t("Nenhum bot cadastrado")}</h5>
                <p className="mt-1 max-w-md text-sm text-text-muted">
                  {t("Valide um token do BotFather para começar a configurar a conexão.")}
                </p>
              </div>
            ) : (
              bots.map((bot) => (
                <article key={bot.id} className="rounded-lg border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <Robot size={19} aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h5 className="font-semibold text-text">{bot.display_name}</h5>
                        <Badge variant={bot.status === "active" ? "secondary" : "outline"}>
                          {t({
                            draft: "Token validado",
                            configured: "Configurado",
                            active: "Ativo",
                            paused: "Pausado",
                            disconnected: "Desconectado",
                            error: "Erro",
                          }[bot.status])}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-text-muted">
                        {bot.bot_username ? `@${bot.bot_username}` : t("Bot Telegram")} ·{" "}
                        {t("token termina em")} {bot.token_last4}
                      </p>
                      <p className="mt-2 text-xs text-text-muted">
                        {bot.bindings.length
                          ? bot.bindings
                              .map(
                                (binding) =>
                                  SURFACES.find((surface) => surface.key === binding.surface)
                                    ?.title ?? binding.surface,
                              )
                              .join(" · ")
                          : t("Nenhuma superfície selecionada")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => editSettings(bot)}
                      disabled={bot.status === "active" || lifecycleConnectionId === bot.id}
                      aria-label={t("Configurações do bot")}
                    >
                      <Gear size={16} aria-hidden="true" />
                      {t("Configurar")}
                    </Button>
                    {bot.status === "active" ? (
                      <Button type="button" size="sm" variant="outline" disabled={lifecycleConnectionId === bot.id} onClick={() => void runLifecycle(bot, "pause")}>
                        {t("Pausar")}
                      </Button>
                    ) : null}
                    {bot.status === "configured" ? (
                      <Button type="button" size="sm" disabled={lifecycleConnectionId === bot.id} onClick={() => void runLifecycle(bot, "activate")}>
                        {t("Ativar")}
                      </Button>
                    ) : null}
                    {bot.status === "paused" || bot.status === "disconnected" || bot.status === "error" ? (
                      <Button type="button" size="sm" disabled={lifecycleConnectionId === bot.id} onClick={() => void runLifecycle(bot, "reactivate")}>
                        {t("Reativar")}
                      </Button>
                    ) : null}
                    {bot.status !== "disconnected" ? (
                      <Button type="button" size="sm" variant="outline" disabled={lifecycleConnectionId === bot.id} onClick={() => void runLifecycle(bot, "disconnect")}>
                        {t("Desconectar")}
                      </Button>
                    ) : null}
                    <Button type="button" size="sm" variant="destructive" disabled={lifecycleConnectionId === bot.id} onClick={() => void runLifecycle(bot, "delete")}>
                      {t("Excluir")}
                    </Button>
                  </div>
                  <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text">
                    {bot.status === "active"
                      ? t("Webhook conectado; as atualizações são armazenadas para processamento idempotente.")
                      : t("Bot ainda não está recebendo atualizações Telegram.")}
                  </p>
                </article>
              ))
            )}
          </div>

          <form
            className="flex flex-col gap-4 rounded-lg border border-border p-4"
            onSubmit={(event) => void addBot(event)}
          >
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Plus size={18} aria-hidden="true" />
              </div>
              <div>
                <h4 className="font-semibold text-text">{t("Adicionar outro bot")}</h4>
                <p className="mt-0.5 text-sm text-text-muted">
                  {t("A conexão é validada com o Telegram antes de ser salva.")}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="telegram-bot-name">{t("Nome para identificar o bot")}</Label>
              <Input
                id="telegram-bot-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                required
                placeholder={t("Ex.: Atendimento da clínica")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="telegram-bot-token">{t("Token do bot")}</Label>
              <Input
                id="telegram-bot-token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                type="password"
                autoComplete="new-password"
                required
                placeholder={t("Cole aqui o token criado no BotFather")}
              />
              <p className="text-xs leading-relaxed text-text-muted">
                {t(
                  "O token será validado e armazenado cifrado. Ele não volta a ser exibido depois de salvar.",
                )}
              </p>
            </div>
            <Button
              type="submit"
              disabled={connecting || !name.trim() || !token.trim()}
              className="mt-auto w-full"
            >
              <Plus size={17} aria-hidden="true" />
              {connecting ? t("Validando token…") : t("Validar e adicionar bot")}
            </Button>
          </form>
        </div>
      </Card>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("Configurações do bot")}
              {selectedBot ? ` · ${selectedBot.display_name}` : ""}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Escolha as superfícies e capacidades que ficam reservadas para esta conexão. Isso não concede cargos nem acesso acima das permissões atuais do usuário.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60dvh] space-y-3 overflow-y-auto pr-1">
            {SURFACES.map((surface) => {
              const Icon = surface.icon;
              const enabled = selection[surface.key].length > 0;
              return (
                <section key={surface.key} className="rounded-lg border border-border p-3">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) => setSurfaceEnabled(surface.key, event.target.checked)}
                      className="mt-1 size-4 accent-accent focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:outline-hidden"
                    />
                    <Icon className="mt-0.5 shrink-0 text-accent" size={18} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-text">{t(surface.title)}</span>
                      <span className="mt-0.5 block text-xs text-text-muted">
                        {t(surface.detail)}
                      </span>
                    </span>
                  </label>
                  {enabled && (
                    <div className="mt-3 ml-7 grid gap-2 border-l-2 border-accent/20 pl-3 sm:grid-cols-2">
                      {surface.capabilities.map((capability) => (
                        <label
                          key={capability.key}
                          className="flex cursor-pointer items-start gap-2 rounded-md bg-surface p-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={selection[surface.key].includes(capability.key)}
                            onChange={(event) =>
                              toggleCapability(surface.key, capability.key, event.target.checked)
                            }
                            className="mt-0.5 size-4 accent-accent focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:outline-hidden"
                          />
                          <span>
                            <span className="block font-medium text-text">
                              {t(capability.title)}
                            </span>
                            <span className="mt-0.5 block text-xs text-text-muted">
                              {t(capability.detail)}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text">
            {t(
              "Capacidades sensíveis, como respostas automáticas de IA, grupos, envio proativo e escrita por agentes, começam desligadas. Nesta etapa, as opções apenas ficam registradas; o transporte Telegram ainda não foi ativado.",
            )}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSettingsOpen(false)}
              disabled={savingSettings}
            >
              {t("Cancelar")}
            </Button>
            <Button
              type="button"
              onClick={() => void saveSettings()}
              disabled={savingSettings || !selectedBot}
            >
              {savingSettings ? t("Salvando…") : t("Salvar configurações")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <PaperPlaneTilt size={18} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text-muted">{label}</p>
        <p className="text-xl font-semibold text-text">{value}</p>
      </div>
      <span className="text-right text-xs text-text-muted">{detail}</span>
    </Card>
  );
}
