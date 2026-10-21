"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import { ArrowsClockwise, Check, CheckCircle, CircleNotch, Clock, Copy, PaperPlaneTilt, Trash, UsersThree, X } from "@/lib/ui/icons";

type Operator = {
  id: string; user_id: string; name: string; email: string | null; phone: string | null;
  telegram_user_id: string; telegram_name: string | null; telegram_username: string | null;
  paired_at: string; authorized: boolean; commands_30d: number; last_used_at: string | null;
};
type Pending = { id: string; user_id: string; name: string; email: string | null; created_at: string; expires_at: string };
type PairingStatus = "pending" | "paired" | "expired" | "cancelled";
type PairingCommand = { command: string; challenge_id: string; expires_at: string };
type Links = { pairing_status: PairingStatus | null; operators: Operator[]; pending: Pending[]; current_user_id: string; truncated: boolean };

function normalizeLinks(value: Partial<Links> | null | undefined): Links {
  return {
    pairing_status: value?.pairing_status ?? null,
    operators: Array.isArray(value?.operators) ? value.operators : [],
    pending: Array.isArray(value?.pending) ? value.pending : [],
    current_user_id: typeof value?.current_user_id === "string" ? value.current_user_id : "",
    truncated: value?.truncated === true,
  };
}
type Removal = { target: "all" } | { target: "operator" | "challenge"; id: string; name: string };
type Props = { botId: string; botName: string; active: boolean };

export function TelegramOperatorLinks({ botId, botName, active }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Links | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ key: string; ok: boolean } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }, []);
  function finishAction(key: string, ok: boolean) {
    setBusy(false);
    setAction(null);
    setFeedback({ key, ok });
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 5000);
  }
  function startAction(key: string) {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback(null);
    setBusy(true);
    setAction(key);
  }
  const actionIcon = (key: string, normal: React.ReactNode) => action === key
    ? <CircleNotch size={16} className="animate-spin" aria-hidden="true" />
    : feedback?.key === key
      ? feedback.ok ? <CheckCircle size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />
      : normal;
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [command, setCommand] = useState<PairingCommand | null>(null);
  const challengeRef = useRef<string | null>(null);
  const [observedChallenge, setObservedChallenge] = useState<{ id: string; expires_at: string } | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingStatus>("pending");
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const [now, setNow] = useState(() => Date.now());
  const path = `/api/v1/channels/telegram/${botId}`;
  const pendingForMe = data?.pending.find(item => item.user_id === data.current_user_id);
  const watchedChallengeId = command?.challenge_id ?? observedChallenge?.id ?? pendingForMe?.id ?? null;
  const expiresAt = command?.expires_at ?? observedChallenge?.expires_at ?? pendingForMe?.expires_at ?? null;
  const message = (err: unknown) => err instanceof ApiError ? err.message : t("Não foi possível atualizar os vínculos.");
  const load = useCallback(async () => {
    const watchedId = watchedChallengeId;
    challengeRef.current = watchedId;
    try {
      const result = await apiClient.get<{ data: Links }>(`${path}/operators${watchedChallengeId ? `?challenge_id=${watchedChallengeId}` : ""}`);
      const links = normalizeLinks(result.data);
      const ownPending = links.pending.find(item => item.user_id === links.current_user_id);
      if (ownPending) setObservedChallenge({ id: ownPending.id, expires_at: ownPending.expires_at });
      setData(links);
      if (links.pairing_status && watchedId === challengeRef.current) {
        setPairingStatus(links.pairing_status);
        if (action === "pair-waiting" && links.pairing_status !== "pending") {
          finishAction("pair", links.pairing_status === "paired");
        }
      }
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Não foi possível listar os vínculos."));
      return false;
    }
  }, [action, path, t, watchedChallengeId]);
  useEffect(() => {
    let cancelled = false;
    void apiClient.get<{ data: Links }>(`${path}/operators`).then(result => {
      if (!cancelled) setData(normalizeLinks(result.data));
    }).catch(() => { /* Opening the modal retries and displays the error. */ });
    return () => { cancelled = true; };
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => { setNow(Date.now()); void load(); }, watchedChallengeId && pairingStatus === "pending" ? 3_000 : 15_000);
    return () => clearInterval(timer);
  }, [open, load, watchedChallengeId, pairingStatus]);
  async function copyCommand() {
    if (!command) return;
    const value = command.command;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedCommand(value);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedCommand(null), 2500);
    } catch {
      toast.error(t("Não foi possível copiar. Selecione o comando e copie manualmente."));
    }
  }
  async function refresh() {
    startAction("refresh");
    const ok = await load();
    finishAction("refresh", ok);
  }
  async function pair() {
    startAction("pair");
    try {
      const result = await apiClient.post<{ data: PairingCommand }>(`${path}/pairing`, {});
      challengeRef.current = result.data.challenge_id;
      setCommand(result.data);
      setObservedChallenge({ id: result.data.challenge_id, expires_at: result.data.expires_at });
      setPairingStatus("pending");
      setNow(Date.now());
      const snapshot = await apiClient.get<{ data: Links }>(`${path}/operators?challenge_id=${result.data.challenge_id}`);
      const links = normalizeLinks(snapshot.data);
      setData(links);
      const status = links.pairing_status ?? "pending";
      setPairingStatus(status);
      if (status === "pending") {
        setBusy(false);
        setAction("pair-waiting");
      } else {
        finishAction("pair", status === "paired");
      }
    } catch (err) {
      toast.error(message(err));
      finishAction("pair", false);
    }
  }
  async function revoke() {
    if (!removal) return;
    const target = removal.target === "all" ? "revoke-all" : "revoke:" + removal.id;
    startAction(target);
    try {
      const body = removal.target === "all" ? { target: "all" } : { target: removal.target, id: removal.id };
      await apiClient.delete(`${path}/operators`, body);
      // A previously generated command may have been cancelled by this action.
      challengeRef.current = null;
      setCommand(null);
      setObservedChallenge(null);
      setPairingStatus("pending");
      setRemoval(null);
      const loaded = await load();
      finishAction(target, loaded);
      if (loaded) toast.success(t("Vínculos atualizados."), { duration: 5000 });
      else toast.error(t("O vínculo foi removido, mas não foi possível atualizar a lista."), { duration: 5000 });
    } catch (err) {
      toast.error(message(err), { duration: 5000 });
      finishAction(target, false);
    }
  }
  const date = (value: string) => new Date(value).toLocaleString();
  const pending = data?.pending.filter(item => new Date(item.expires_at).getTime() > now) ?? [];
  const count = data ? data.operators.length : null;
  const isPairingWaiting = action === "pair-waiting" || Boolean(pendingForMe && pairingStatus === "pending" && expiresAt && new Date(expiresAt).getTime() > now);
  const isPairingProcessing = action === "pair";
  const removalActionKey = removal?.target === "all" ? "revoke-all" : removal ? "revoke:" + removal.id : null;
  const feedbackLabel = (key: string, normal: string, success: string, failure: string) => feedback?.key === key ? t(feedback.ok ? success : failure) : t(normal);
  return <>
    <Button type="button" variant="outline" size="sm" onClick={() => { setNow(Date.now()); setOpen(true); void load(); }}>
      <UsersThree size={16} aria-hidden="true" />{t("Vínculos")}{count !== null ? ` · ${count}` : ""}
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Vínculos de operadores")} · {botName}</DialogTitle>
          <DialogDescription>{t("Contas autorizadas a consultar e responder casos humanos pelo Telegram. Desvincular não desconecta o bot nem interrompe a Inbox.")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          {active ? <Button type="button" disabled={busy || isPairingWaiting} className={isPairingWaiting ? "border-warning/60 bg-warning/10 text-warning-fg hover:bg-warning/15" : undefined} onClick={() => void pair()}>
            {isPairingWaiting && !isPairingProcessing ? <Clock size={16} aria-hidden="true" /> : actionIcon("pair", <PaperPlaneTilt size={16} aria-hidden="true" />)}
            {isPairingWaiting || isPairingProcessing ? t("Vinculando Telegram…") : feedbackLabel("pair", "Vincular meu Telegram", "Telegram vinculado!", "Falha ao vincular")}
          </Button> : null}
          {!error && data ? <Button type="button" variant="destructive" className="ml-auto" disabled={busy || (!data.operators.length && !pending.length)} onClick={() => setRemoval({ target: "all" })}>
            {actionIcon("revoke-all", <Trash size={16} aria-hidden="true" />)}{feedbackLabel("revoke-all", "Desvincular todos", "Desvinculados!", "Falha ao desvincular")}
          </Button> : null}
          <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>
            {actionIcon("refresh", <ArrowsClockwise size={16} aria-hidden="true" />)}{action === "refresh" ? t("Atualizando…") : feedbackLabel("refresh", "Atualizar", "Atualizado!", "Falha ao atualizar")}
          </Button>
        </div>
        {!active ? <p className="text-sm text-text-muted">{t("Para vincular, ative o bot e habilite consulta e resposta de casos nas configurações.")}</p> : null}
        {expiresAt ? <div role="status" aria-live="polite" className={`space-y-2 break-words rounded-md border p-3 text-sm ${pairingStatus === "paired"
          ? "border-success/40 bg-success/10 text-success-fg"
          : pairingStatus === "pending" && new Date(expiresAt).getTime() > now
            ? "border-warning/50 bg-warning/10 motion-safe:animate-pulse"
            : "border-border bg-muted"}`}>
          {pairingStatus === "paired" ? <p className="font-medium">{t("Telegram vinculado com sucesso. A lista de operadores foi atualizada.")}</p>
            : pairingStatus === "cancelled" ? <p>{t("Este código foi cancelado ou substituído. Gere um novo para vincular.")}</p>
            : pairingStatus === "expired" || new Date(expiresAt).getTime() <= now ? <p>{t("Código expirado. Gere um novo para vincular sua conta.")}</p>
            : <>
              <p className="font-medium">{t("Aguardando confirmação no Telegram…")}</p>
              <p>{t("Envie este comando na conversa privada com o bot antes de")} {date(expiresAt)}:</p>
              {command ? <button
                type="button"
                onClick={() => void copyCommand()}
                aria-label={t("Copiar comando de pareamento")}
                className="flex w-full cursor-pointer items-center gap-3 rounded bg-background/70 p-2 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <code className="min-w-0 flex-1 break-all select-text">{command.command}</code>
                <span className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
                  {copiedCommand === command.command ? <><span className="text-xs font-medium">{t("Copiado!")}</span><Check size={18} aria-hidden="true" /></> : <Copy size={18} aria-hidden="true" />}
                </span>
              </button>
                : <p>{t("Use o código que você já gerou. Se não o tiver, gere outro; o anterior será invalidado.")}</p>}
              <p className="text-xs">{t("A confirmação e a lista serão atualizadas automaticamente. Gerar outro código invalida o anterior.")}</p>
            </>}
        </div> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {!data && !error ? <p role="status">{t("Carregando…")}</p> : null}
        {data && !error ? <>
          <h3 className="font-semibold">{t("Operadores vinculados")} · {data.operators.length}</h3>
          {!data.operators.length ? <p className="text-sm text-text-muted">{t("Nenhum operador vinculado a este bot.")}</p> : null}
          {data.operators.map(item => <article key={item.id} className="min-w-0 space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="break-words font-medium">{item.name} {item.user_id === data.current_user_id ? <Badge>{t("Você")}</Badge> : null}</p>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setRemoval({ target: "operator", id: item.id, name: item.name })}>
                {actionIcon("revoke:" + item.id, <Trash size={16} aria-hidden="true" />)}{feedbackLabel("revoke:" + item.id, "Desvincular", "Desvinculado!", "Falha ao desvincular")}
              </Button>
            </div>
            <dl className="grid gap-1 break-words text-sm text-text-muted">
              <div><dt className="inline">{t("E-mail")}: </dt><dd className="inline">{item.email ?? t("Não informado")}</dd></div>
              <div><dt className="inline">{t("Telefone no CRM")}: </dt><dd className="inline">{item.phone ?? t("Não informado")}</dd></div>
              <div><dt className="inline">Telegram: </dt><dd className="inline">{[item.telegram_name, item.telegram_username ? `@${item.telegram_username}` : null].filter(Boolean).join(" · ") || t("Nome ainda não registrado")} · ID {item.telegram_user_id}</dd></div>
              <div><dt className="inline">{t("Vinculado em")}: </dt><dd className="inline">{date(item.paired_at)}</dd></div>
              <div><dt className="inline">{t("Comandos registrados nos últimos 30 dias")}: </dt><dd className="inline">{item.commands_30d}</dd></div>
              <div><dt className="inline">{t("Último uso registrado nessa janela")}: </dt><dd className="inline">{item.last_used_at ? date(item.last_used_at) : t("Sem registro")}</dd></div>
            </dl>
            {!item.authorized ? <p className="text-sm text-destructive">{t("Usuário sem permissão atual para operar casos. Revogue este vínculo.")}</p> : null}
          </article>)}
          <p className="text-xs text-text-muted">{t("O telefone é o cadastrado no CRM; o Telegram não o informa automaticamente. A contagem considera comandos de casos registrados após a atualização, não todas as mensagens.")}</p>
          <h3 className="font-semibold">{t("Aguardando confirmação")} · {pending.length}</h3>
          {pending.map(item => <article key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
            <div className="min-w-0 break-words"><p className="font-medium">{item.name}</p><p>{item.email}</p><p>{t("Solicitado em")}: {date(item.created_at)}</p><p>{t("Expira em")}: {date(item.expires_at)}</p></div>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setRemoval({ target: "challenge", id: item.id, name: item.name })}>
              {actionIcon("revoke:" + item.id, <Trash size={16} aria-hidden="true" />)}{feedbackLabel("revoke:" + item.id, "Cancelar vínculo pendente", "Vínculo cancelado!", "Falha ao cancelar")}
            </Button>
          </article>)}
          {data.truncated ? <p role="status">{t("Exibindo os primeiros 200 registros de cada lista.")}</p> : null}
        </> : null}
        <div className="flex justify-end border-t pt-3">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}><X size={16} aria-hidden="true" />{t("Fechar")}</Button>
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={removal !== null} onOpenChange={value => { if (!value && !busy) setRemoval(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{removal?.target === "all" ? t("Desvincular todos os operadores?") : t("Remover este vínculo?")}</AlertDialogTitle>
          <AlertDialogDescription>{removal?.target === "all"
            ? t("Todos os operadores deste bot perderão o acesso aos casos pelo Telegram e os códigos pendentes serão cancelados. O bot continuará conectado.")
            : <>{removal && "name" in removal ? removal.name : ""}. {t("O acesso deste vínculo será removido e será necessário gerar outro código para vincular novamente. Os outros operadores continuarão vinculados.")}</>}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}><X size={16} aria-hidden="true" />{t("Cancelar")}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void revoke()}>
            {removalActionKey ? actionIcon(removalActionKey, <Trash size={16} aria-hidden="true" />) : <Trash size={16} aria-hidden="true" />}
            {busy ? t("Desvinculando…") : feedback?.key === removalActionKey ? t(feedback.ok ? "Desvinculado!" : "Falha ao desvincular") : t("Confirmar")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
