import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramCaseAlertDestination } from "./TelegramCaseAlertDestination";

const { get, put, toastSuccess, toastError } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    put: (...args: unknown[]) => put(...args),
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const Context = React.createContext<{ onValueChange: (value: string) => void } | null>(null);
  return {
    Select: ({
      onValueChange,
      children,
    }: {
      onValueChange: (value: string) => void;
      children: React.ReactNode;
    }) => <Context.Provider value={{ onValueChange }}>{children}</Context.Provider>,
    SelectTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" role="combobox" {...props}>
        {children}
      </button>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({
      value,
      disabled,
      children,
    }: {
      value: string;
      disabled?: boolean;
      children: React.ReactNode;
    }) => {
      const context = React.useContext(Context);
      return (
        <button
          type="button"
          role="option"
          disabled={disabled}
          onClick={() => context?.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
    SelectValue: () => null,
  };
});

const eligibleGroup = {
  group_setting_id: "11111111-1111-4111-8111-111111111111",
  group_chat_id: "-1009876543210",
  subject: "Equipe QA",
  bot_name: "Bot QA",
  bot_username: "qa_alert_bot",
  membership_state: "healthy",
  eligible: true,
};
const ineligibleGroup = {
  ...eligibleGroup,
  group_setting_id: "22222222-2222-4222-8222-222222222222",
  subject: "Equipe pendente",
  membership_state: "suspended",
  eligible: false,
};
function wrap(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  vi.clearAllMocks();
  get.mockResolvedValue({
    data: { groups: [eligibleGroup], group_setting_id: null, destination_type: null },
  });
  put.mockResolvedValue({ data: { saved: true } });
});
afterEach(() => cleanup());

describe("TelegramCaseAlertDestination", () => {
  it("salva o destino elegível no registro compartilhado e atualiza a leitura do servidor", async () => {
    const user = userEvent.setup();
    wrap(<TelegramCaseAlertDestination />);
    await screen.findByRole("combobox");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Bot QA · Equipe QA/ }));
    await user.click(screen.getByRole("button", { name: "Salvar destino Telegram" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/ai/cases/telegram-destination", {
        group_setting_id: eligibleGroup.group_setting_id,
      }),
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(toastSuccess).toHaveBeenCalledWith("Destino Telegram salvo.");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("não permite selecionar grupos suspensos e explica o bloqueio do destino salvo", async () => {
    get.mockResolvedValue({
      data: {
        groups: [ineligibleGroup],
        group_setting_id: ineligibleGroup.group_setting_id,
        destination_type: "telegram",
      },
    });
    wrap(<TelegramCaseAlertDestination />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /perdeu a validação de participantes/i,
    );
    await userEvent.setup().click(screen.getByRole("combobox"));
    expect(
      await screen.findByRole("option", { name: /Equipe pendente · revisão necessária/ }),
    ).toBeDisabled();
  });

  it("permite remover o destino selecionando Desativado", async () => {
    get.mockResolvedValue({
      data: {
        groups: [eligibleGroup],
        group_setting_id: eligibleGroup.group_setting_id,
        destination_type: "telegram",
      },
    });
    const user = userEvent.setup();
    wrap(<TelegramCaseAlertDestination />);
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Desativado" }));
    await user.click(screen.getByRole("button", { name: "Salvar destino Telegram" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/ai/cases/telegram-destination", {
        group_setting_id: null,
      }),
    );
  });
});
