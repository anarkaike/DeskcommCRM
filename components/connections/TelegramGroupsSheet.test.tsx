import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramGroupsSheet } from "./TelegramGroupsSheet";

const fetchMock = vi.fn();
const group = {
  channel_session_group_id: "33333333-3333-4333-8333-333333333333",
  group_chat_id: "-100123456789",
  subject: "Equipe QA",
  inbox_enabled: false,
  case_alerts_enabled: true,
  selected_for_case_alerts: true,
  case_actions_enabled: true,
  team_assistant_enabled: false,
  membership_state: "healthy" as const,
  membership_attested_at: "2026-10-26T12:00:00Z",
  assistant_disabled_reason: null,
  observed_members: 1,
  unknown_members: 0,
  members: [
    {
      telegram_user_id: "987654321",
      display_name: "Junio QA",
      username: "junio_qa",
      membership_status: "member",
      paired_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      can_use_assistant: false,
      can_read_cases: false,
      can_act_on_cases: false,
      can_approve_members: false,
      reviewed_at: "2026-10-26T12:00:00Z",
    },
  ],
};
const response = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status }),
  );

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("TelegramGroupsSheet", () => {
  it("permite conceder leitura de casos sem conceder poder de agir", async () => {
    fetchMock
      .mockReturnValueOnce(response([group]))
      .mockReturnValueOnce(response({ saved: true }))
      .mockReturnValueOnce(
        response([
          {
            ...group,
            members: [{ ...group.members[0], can_read_cases: true }],
          },
        ]),
      );
    render(
      <TelegramGroupsSheet
        connectionId="22222222-2222-4222-8222-222222222222"
        onClose={() => {}}
      />,
    );

    const read = await screen.findByRole("switch", { name: "Pode consultar casos" });
    expect(read).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Pode agir em casos" })).toBeDisabled();

    fireEvent.click(read);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const patch = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(patch.method).toBe("PATCH");
    expect(JSON.parse(String(patch.body))).toMatchObject({
      can_read_cases: true,
      can_act_on_cases: false,
      can_approve_members: false,
      can_use_assistant: false,
    });
    expect(await screen.findByRole("switch", { name: "Pode consultar casos" })).toBeChecked();
  });

  it("allows read and assistant grants while case actions stay disabled", async () => {
    const readGranted = {
      ...group,
      case_actions_enabled: false,
      members: [{ ...group.members[0], can_read_cases: true }],
    };
    const assistantGranted = {
      ...readGranted,
      members: [{ ...group.members[0], can_read_cases: true, can_use_assistant: true }],
    };
    const assistantEnabled = { ...assistantGranted, team_assistant_enabled: true };
    fetchMock
      .mockReturnValueOnce(response([group]))
      .mockReturnValueOnce(response({ saved: true }))
      .mockReturnValueOnce(response([readGranted]))
      .mockReturnValueOnce(response({ saved: true }))
      .mockReturnValueOnce(response([assistantGranted]))
      .mockReturnValueOnce(response({ saved: true }))
      .mockReturnValueOnce(response([assistantEnabled]));
    render(
      <TelegramGroupsSheet
        connectionId="22222222-2222-4222-8222-222222222222"
        onClose={() => {}}
      />,
    );

    const read = await screen.findByRole("switch", { name: "Pode consultar casos" });
    expect(read).toBeEnabled();
    fireEvent.click(read);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const assistantMember = await screen.findByRole("switch", { name: "Pode usar o assistente interno" });
    expect(assistantMember).toBeEnabled();
    fireEvent.click(assistantMember);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body))).toMatchObject({
      can_use_assistant: true,
      can_read_cases: true,
      can_act_on_cases: false,
    });

    const assistantGroup = await screen.findByRole("switch", { name: "Assistente de IA interno" });
    expect(assistantGroup).toBeEnabled();
    fireEvent.click(assistantGroup);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    expect(JSON.parse(String((fetchMock.mock.calls[5]?.[1] as RequestInit).body))).toMatchObject({
      team_assistant_enabled: true,
    });
    expect(screen.getByRole("switch", { name: "Acoes de casos pelo grupo" })).not.toBeChecked();
  });
});
