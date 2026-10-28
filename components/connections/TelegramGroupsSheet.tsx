"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { ArrowsClockwise, ChatCircle, ShieldCheck } from "@/lib/ui/icons";
type Member = {
  telegram_user_id: string;
  display_name: string | null;
  username: string | null;
  membership_status: string;
  paired_user_id: string | null;
  can_use_assistant: boolean;
  can_read_cases: boolean;
  can_act_on_cases: boolean;
  can_approve_members: boolean;
  reviewed_at: string | null;
  approval_state: string;
};
type Group = {
  channel_session_group_id: string;
  group_chat_id: string;
  subject: string | null;
  inbox_enabled: boolean;
  case_alerts_enabled: boolean;
  selected_for_case_alerts?: boolean;
  case_actions_enabled: boolean;
  team_assistant_enabled: boolean;
  membership_state: "unknown" | "healthy" | "stale" | "suspended";
  membership_attested_at: string | null;
  assistant_disabled_reason: string | null;
  observed_members: number;
  unknown_members: number;
  members: Member[];
};
export function TelegramGroupsSheet({
  connectionId,
  onClose,
}: {
  connectionId: string;
  onClose: () => void;
}) {
  const t = useT();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attesting, setAttesting] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/v1/channels/telegram/${connectionId}/groups`, {
        cache: "no-store",
      });
      const j = (await r.json()) as { data?: Group[]; error?: { message?: string } };
      if (!r.ok || !j.data)
        throw new Error(j.error?.message ?? t("Nao foi possivel carregar os grupos."));
      setGroups(j.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Nao foi possivel carregar os grupos."));
    }
  }, [connectionId, t]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(
    g: Group,
    patch: Partial<Pick<Group, "inbox_enabled" | "case_alerts_enabled" | "case_actions_enabled" | "team_assistant_enabled">>,
  ) {
    setBusy(g.group_chat_id);
    setError(null);
    try {
      const r = await fetch(`/api/v1/channels/telegram/${connectionId}/groups`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ group_chat_id: g.group_chat_id, subject: g.subject, ...patch }),
      });
      const j = (await r.json()) as { error?: { message?: string } };
      if (!r.ok) throw new Error(j.error?.message ?? t("Nao foi possivel salvar."));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Nao foi possivel salvar."));
    } finally {
      setBusy(null);
    }
  }
  async function grant(
    g: Group,
    m: Member,
    key: "can_use_assistant" | "can_read_cases" | "can_act_on_cases" | "can_approve_members",
    value: boolean,
  ) {
    const id = g.group_chat_id + ":" + m.telegram_user_id;
    setBusy(id);
    setError(null);
    try {
      const r = await fetch(
        `/api/v1/channels/telegram/${connectionId}/groups/members/${m.telegram_user_id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            can_use_assistant:
              key === "can_use_assistant"
                ? value
                : key === "can_read_cases" && !value
                  ? false
                  : m.can_use_assistant,
            can_read_cases:
              key === "can_read_cases"
                ? value
                : key === "can_act_on_cases"
                  ? value || m.can_read_cases
                  : m.can_read_cases,
            can_act_on_cases:
              key === "can_act_on_cases"
                ? value
                : key === "can_read_cases" && !value
                  ? false
                  : m.can_act_on_cases,
            can_approve_members: key === "can_approve_members" ? value : m.can_approve_members,
          }),
        },
      );
      const j = (await r.json()) as { error?: { message?: string } };
      if (!r.ok) throw new Error(j.error?.message ?? t("Nao foi possivel salvar."));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Nao foi possivel salvar."));
    } finally {
      setBusy(null);
    }
  }
  async function reviewMember(g: Group, m: Member) {
    const id = g.group_chat_id + ":" + m.telegram_user_id;
    setBusy(id);
    setError(null);
    try {
      const r = await fetch(
        "/api/v1/channels/telegram/" + connectionId + "/groups/members/" + m.telegram_user_id,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            can_use_assistant: false,
            can_read_cases: m.can_read_cases,
            can_act_on_cases: m.can_act_on_cases,
            can_approve_members: m.can_approve_members,
          }),
        },
      );
      const j = (await r.json()) as { error?: { message?: string } };
      if (!r.ok) throw new Error(j.error?.message ?? t("Nao foi possivel salvar."));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Nao foi possivel salvar."));
    } finally {
      setBusy(null);
    }
  }
  async function reconcile(g: Group) {
    if (
      !window.confirm(
        t(
          "Confirma que revisou todos os participantes observados? O Telegram não fornece uma lista completa de membros; esta confirmação não prova que todos os membros do grupo foram enumerados.",
        ),
      )
    )
      return;
    setAttesting(g.group_chat_id);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/v1/channels/telegram/${connectionId}/groups/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          group_chat_id: g.group_chat_id,
          confirm_observed_members_reviewed: true,
        }),
      });
      const j = (await r.json()) as { error?: { message?: string } };
      if (!r.ok) throw new Error(j.error?.message ?? t("Nao foi possivel reconciliar o grupo."));
      setNotice(
        t("Participantes observados reconciliados. O Telegram não fornece inventário completo."),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Nao foi possivel reconciliar o grupo."));
    } finally {
      setAttesting(null);
    }
  }
  const norm = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const visible = (groups ?? []).filter((g) =>
    norm(`${g.subject ?? ""} ${g.group_chat_id}`).includes(norm(search)),
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-2xl"
      >
        <SheetHeader className="pr-10">
          <SheetTitle>{t("Grupos e comunidades do Telegram")}</SheetTitle>
          <SheetDescription>
            {t(
              "Cada grupo tem permissoes independentes. Inbox nao ativa avisos, IA ou acoes de casos.",
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void load()}
              disabled={busy !== null || attesting !== null}
            >
              <ArrowsClockwise size={16} aria-hidden="true" />
              {t("Atualizar lista")}
            </Button>
            <Badge variant="outline">
              {t("Grupos vistos")}: {groups?.length ?? "..."}
            </Badge>
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Buscar grupo")}
          />
          {error && (
            <p role="alert" className="border-danger/40 bg-danger/10 rounded-md border p-3 text-sm">
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="rounded-md border border-success/40 bg-success/10 p-3 text-sm"
            >
              {notice}
            </p>
          )}
          {groups?.length === 0 && (
            <Card className="p-4 text-sm text-text-muted">
              {t("Nenhum grupo observado. Adicione o bot e envie uma mensagem ou mencione-o.")}
            </Card>
          )}
          {visible.map((g) => (
            <Card key={g.group_chat_id} className="space-y-4 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-semibold">{g.subject || t("Grupo sem nome")}</h3>
                    {g.selected_for_case_alerts && (
                      <Badge variant="secondary">{t("Destino atual de avisos")}</Badge>
                    )}
                  </div>
                  <p className="text-xs break-all text-text-muted">{g.group_chat_id}</p>
                </div>
                <Badge variant={g.membership_state === "healthy" ? "secondary" : "outline"}>
                  {g.membership_state === "healthy"
                    ? t("Reconciliacao administrativa vigente")
                    : t("Revisao necessaria")}
                </Badge>
              </div>
              <p className="text-xs text-text-muted">
                <ShieldCheck size={14} className="mr-1 inline" />
                {t("Membros observados")}: {g.observed_members}; {t("a revisar")}:{" "}
                {g.unknown_members}.{" "}
                {t(
                  "O Telegram nao fornece inventario completo; revisar os observados nao garante que todos foram vistos.",
                )}
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <Capability
                  title={t("Receber mensagens na Inbox")}
                  detail={t("Conversas humanas; nao aciona roteadores nem IA de atendimento.")}
                  checked={g.inbox_enabled}
                  disabled={busy === g.group_chat_id}
                  onChange={(v) => void save(g, { inbox_enabled: v })}
                  icon={<ChatCircle size={16} />}
                />
                <Capability
                  title={t("Receber avisos de casos")}
                  detail={t("Permite selecionar este grupo como destino em Casos → Avisos.")}
                  checked={g.case_alerts_enabled}
                  disabled={busy === g.group_chat_id}
                  onChange={(v) => void save(g, { case_alerts_enabled: v })}
                  icon={<ShieldCheck size={16} />}
                />
                <Capability
                  title={t("Acoes de casos pelo grupo")}
                  detail={t(
                    "Requer bot habilitado para casos, conciliacao do grupo e grants individuais.",
                  )}
                  checked={g.case_actions_enabled}
                  disabled={busy === g.group_chat_id || g.membership_state !== "healthy"}
                  onChange={(v) => void save(g, { case_actions_enabled: v })}
                  icon={<ShieldCheck size={16} />}
                />
                <Capability
                  title={t("Assistente de IA interno")}
                  detail={t("Responde somente em conversas com o bot vinculadas a um caso; nunca altera casos nem envia respostas ao cliente.")}
                  checked={g.team_assistant_enabled}
                  disabled={busy === g.group_chat_id || g.membership_state !== "healthy" || !g.members.some((m) => m.can_use_assistant && m.can_read_cases && m.reviewed_at)}
                  onChange={(v) => void save(g, { team_assistant_enabled: v })}
                  icon={<ShieldCheck size={16} />}
                />
              </div>
              {g.members.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-sm font-semibold">{t("Participantes observados")}</h4>
                  {g.members.map((m) => (
                    <div
                      key={m.telegram_user_id}
                      className="space-y-2 rounded-md border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {rotuloDoContato({ name: m.display_name, display_name: m.username ? `@${m.username}` : null }, t)}
                          <code className="ml-2 text-xs text-text-muted">{m.telegram_user_id}</code>
                          <span className="ml-2 text-xs text-text-muted">
                            {m.approval_state === "observer" ? t("Observador aprovado") : m.approval_state === "denied" ? t("Sem acesso aprovado") : m.paired_user_id ? t("Pareado ao CRM") : t("Sem pareamento")}
                          </span>
                        </span>
                        <Badge
                          variant={
                            m.membership_status === "member" && m.paired_user_id
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {m.membership_status}
                        </Badge>
                      </div>
                      {m.membership_status === "member" && m.paired_user_id && !m.reviewed_at && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => void reviewMember(g, m)}
                        >
                          {t("Confirmar identidade e revisar")}
                        </Button>
                      )}
                      {m.membership_status === "member" && m.paired_user_id && (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <MemberGrant
                            label={t("Pode usar o assistente interno")}
                            checked={m.can_use_assistant}
                            disabled={busy !== null || g.membership_state !== "healthy" || !m.can_read_cases}
                            onChange={(v) => void grant(g, m, "can_use_assistant", v)}
                          />
                          <MemberGrant
                            label={t("Pode consultar casos")}
                            checked={m.can_read_cases}
                            disabled={busy !== null || g.membership_state !== "healthy"}
                            onChange={(v) => void grant(g, m, "can_read_cases", v)}
                          />
                          <MemberGrant
                            label={t("Pode agir em casos")}
                            checked={m.can_act_on_cases}
                            disabled={
                              busy !== null ||
                              !g.case_actions_enabled ||
                              g.membership_state !== "healthy" ||
                              !m.can_read_cases
                            }
                            onChange={(v) => void grant(g, m, "can_act_on_cases", v)}
                          />
                          <MemberGrant
                            label={t("Pode aprovar membros")}
                            checked={m.can_approve_members}
                            disabled={busy !== null}
                            onChange={(v) => void grant(g, m, "can_approve_members", v)}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              )}
              {g.membership_state !== "healthy" && (
                <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
                  {t(
                    "Acoes de casos e IA ficam bloqueadas ate reconciliar e aprovar participantes observados.",
                  )}
                </p>
              )}
              <Button type="button" variant="outline" onClick={() => void reconcile(g)}
                disabled={
                  attesting !== null ||
                  busy !== null ||
                  g.unknown_members > 0 ||
                  g.observed_members === 0
                }
              >
                {attesting === g.group_chat_id
                  ? t("Reconciliando...")
                  : t("Reconciliar participantes observados")}
              </Button>
            </Card>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
function Capability(p: {
  title: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  icon: ReactNode;
}) {
  return (
    <label className="flex min-h-20 items-start justify-between gap-3 rounded-lg border p-3">
      <span className="flex min-w-0 gap-2">
        <span className="mt-0.5 text-text-muted">{p.icon}</span>
        <span>
          <span className="block text-sm font-medium">{p.title}</span>
          <span className="mt-1 block text-xs text-text-muted">{p.detail}</span>
        </span>
      </span>
      <Switch
        checked={p.checked}
        disabled={p.disabled}
        onCheckedChange={p.onChange}
        aria-label={p.title}
      />
    </label>
  );
}
function MemberGrant({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-md bg-surface px-2 py-1.5 text-xs">
      <span>{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
