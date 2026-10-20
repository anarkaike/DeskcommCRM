import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConexaoCaidaBanner } from "@/components/app/ConexaoCaidaBanner";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { AuthUser, Role } from "@/lib/auth/types";
import type { ConexaoCaida } from "@/lib/channels/health";

vi.mock("@/lib/supabase/browser", () => ({
  resetRealtimeAuthentication: vi.fn(),
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
}));

const baseUser: AuthUser = {
  id: "actor", email: "actor@example.test", full_name: null, avatar_url: null,
  organizations: [{ organization_id: "org", organization_name: "Organização", role: "admin" }],
  idioma: "pt-BR", is_platform_admin: false,
};
const support: NonNullable<AuthUser["support"]> = {
  id: "support", organization_id: "org", actor_user_id: "actor", auth_session_id: "session",
  previous_organization_id: null, expires_at: "2030-01-01T00:00:00Z", name: "Organização",
  locale: "pt-BR", access_mode: "support_readonly", status: "active",
};
function view(role: Role, locale: "pt-BR" | "es", who = baseUser, caidas: ConexaoCaida[] = [{ id: "channel", apelido: "Vendas", status: "SCAN_QR_CODE", provider: "waha" }]) {
  return <AuthProvider user={who} activeOrg={{ orgId: "org", name: "Organização", role }}>
    <IdiomaProvider locale={locale}><ConexaoCaidaBanner caidas={caidas} /></IdiomaProvider>
  </AuthProvider>;
}
const copy = {
  "pt-BR": { qr: "Escanear o QR", connections: "Ver conexões", help: "Peça a quem administra para revisar a conexão do WhatsApp.", outage: "nenhuma mensagem entra nem sai." },
  es: { qr: "Escanear el QR", connections: "Ver conexiones", help: "Pide a quien administra que revise la conexión de WhatsApp.", outage: "ningún mensaje entra ni sale." },
};

describe.each(["pt-BR", "es"] as const)("alerta de conexão em %s", locale => {
  it.each([
    ["admin do tenant", "admin", baseUser],
    ["plataforma fora do suporte", "agent", { ...baseUser, is_platform_admin: true }],
    ["suporte de edição", "admin", { ...baseUser, is_platform_admin: true, support: { ...support, access_mode: "full" } }],
  ] as const)("%s abre Conexões com a ação adequada ao estado", (_name, role, who) => {
    const mounted = render(view(role, locale, who));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Vendas");
    expect(within(alert).getByRole("link", { name: copy[locale].qr })).toHaveAttribute("href", "/app/connections");
    expect(within(alert).queryByText(copy[locale].help)).toBeNull();
    mounted.rerender(view(role, locale, who, [{ id: "channel", apelido: "Vendas", status: "FAILED", provider: "waha" }]));
    expect(within(screen.getByRole("alert")).getByRole("link", { name: copy[locale].connections })).toHaveAttribute("href", "/app/connections");
  });

  it.each([
    ["atendente", "agent", baseUser],
    ["gerente", "manager", baseUser],
    ["viewer", "viewer", baseUser],
    ["plataforma em suporte somente leitura com vínculo físico admin", "viewer", { ...baseUser, is_platform_admin: true, support }],
  ] as const)("%s recebe o alerta e uma orientação, sem CTA proibida", (_name, role, who) => {
    render(view(role, locale, who));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Vendas");
    expect(alert).toHaveTextContent(copy[locale].outage);
    expect(within(alert).queryByRole("link")).toBeNull();
    expect(within(alert).getByText(copy[locale].help)).toBeVisible();
  });

  it("retira o alerta quando não há conexão caída", () => {
    const mounted = render(view("agent", locale));
    expect(screen.getByRole("alert")).toBeVisible();
    mounted.rerender(view("agent", locale, baseUser, []));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("identifica Telegram pelo provider e mantém WhatsApp para sessões WAHA", () => {
    const telegram = { id: "telegram", apelido: "DiskUniformesVendasDev_bot", status: "STOPPED", provider: "telegram" } as ConexaoCaida;
    const whatsapp = { id: "waha", apelido: "Vendas", status: "SCAN_QR_CODE", provider: "waha" } as ConexaoCaida;
    const { rerender } = render(view("admin", locale, baseUser, [telegram]));
    expect(screen.getByRole("alert")).toHaveTextContent("Telegram DiskUniformesVendasDev_bot está desconectado");

    rerender(view("admin", locale, baseUser, [whatsapp]));
    expect(screen.getByRole("alert")).toHaveTextContent("WhatsApp Vendas está desconectado");

    rerender(view("admin", locale, baseUser, [telegram, { ...telegram, id: "telegram-2" }]));
    expect(screen.getByRole("alert")).toHaveTextContent(locale === "es" ? "2 conexiones de Telegram están desconectadas" : "2 conexões de Telegram estão desconectadas");

    rerender(view("admin", locale, baseUser, [telegram, whatsapp]));
    expect(screen.getByRole("alert")).toHaveTextContent(locale === "es" ? "2 conexiones de canales de mensajería están desconectados" : "2 conexões de canais de mensagem estão desconectados");
  });
});
