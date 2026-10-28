"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { ApiError } from "@/lib/api/types";

type Group = {
  group_setting_id: string;
  group_chat_id: string;
  subject: string | null;
  bot_name: string;
  bot_username: string | null;
  membership_state: string;
  eligible: boolean;
};
type Payload = {
  groups: Group[];
  group_setting_id: string | null;
  destination_type: "whatsapp" | "telegram" | null;
};
type Envelope<T> = { data: T };
const QUERY_KEY = ["telegram-case-alert-destinations"] as const;

export function TelegramCaseAlertDestination() {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | undefined>();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      apiClient.get<Envelope<Payload>>("/api/v1/ai/cases/telegram-destination").then((r) => r.data),
    retry: 1,
  });
  const state = query.data;
  const value = draft ?? state?.group_setting_id ?? "";
  const saveMutation = useMutation({
    mutationFn: (groupSettingId: string | null) =>
      apiClient.put("/api/v1/ai/cases/telegram-destination", {
        group_setting_id: groupSettingId,
      }),
    onSuccess: async () => {
      toast.success(t("Destino Telegram salvo."));
      setDraft(undefined);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (e) => {
      toast.error(
        e instanceof ApiError ? e.message : t("Não foi possível salvar o destino Telegram."),
      );
    },
  });
  const selected = state?.groups.find((g) => g.group_setting_id === value);
  const loading = query.isLoading;
  const saving = saveMutation.isPending;
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="font-semibold">{t("Grupo Telegram para avisos de casos")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Escolha um grupo autorizado em Conexões. Esta é a mesma configuração de destino dos avisos de casos: ao salvar Telegram, a rota WhatsApp deixa de ser o destino ativo.",
          )}
        </p>
      </div>
      {query.isError && (
        <p role="alert" className="rounded-md border p-3 text-sm text-destructive">
          {query.error instanceof ApiError
            ? query.error.message
            : t("Não foi possível carregar destinos Telegram. Atualize para tentar novamente.")}
        </p>
      )}
      {state?.groups.length ? (
        <Select
          value={value || "disabled"}
          onValueChange={(v) => setDraft(v === "disabled" ? "" : v)}
          disabled={loading || saving}
        >
          <SelectTrigger className="w-full sm:max-w-xl">
            <SelectValue placeholder={t("Sem destino Telegram")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">{t("Desativado")}</SelectItem>
            {state.groups.map((g) => (
              <SelectItem
                key={g.group_setting_id}
                value={g.group_setting_id}
                disabled={!g.eligible}
              >
                {g.bot_name} · {g.subject || g.group_chat_id}
                {g.eligible ? "" : ` · ${t("revisão necessária")}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          {t(
            "Nenhum grupo elegível. Habilite Avisos de casos no grupo e Enviar avisos de casos nas configurações do bot.",
          )}
        </p>
      )}
      {state?.destination_type === "whatsapp" && (
        <p className="text-xs text-muted-foreground">
          {t(
            "Atualmente, o destino ativo é WhatsApp. Salvar um grupo Telegram trocará o destino da organização.",
          )}
        </p>
      )}
      {selected && !selected.eligible && (
        <p
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {t(
            "O destino salvo perdeu a validação de participantes. Os avisos ficam pausados até reconciliar o grupo em Conexões.",
          )}
        </p>
      )}
      {state?.group_setting_id && !selected && (
        <p
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {t(
            "O destino salvo não está mais disponível. Os avisos ficam pausados; escolha um grupo elegível ou desative o destino.",
          )}
        </p>
      )}
      {selected && (
        <p className="text-xs text-muted-foreground">
          {selected.bot_username ? "@" + selected.bot_username + " · " : ""}
          {t("Estado do grupo")}: {selected.membership_state}.{" "}
          {t("Mensagens e ações de casos permanecem separadas da Inbox.")}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => saveMutation.mutate(value || null)}
          disabled={loading || saving || !state || query.isError}
        >
          {saving ? t("Salvando…") : t("Salvar destino Telegram")}
        </Button>
      </div>
    </Card>
  );
}
