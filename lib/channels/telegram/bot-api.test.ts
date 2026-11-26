import { afterEach, describe, expect, it, vi } from "vitest";
import { answerTelegramCallbackQuery, fetchTelegramMedia, sendTelegramMedia, sendTelegramText } from "./bot-api";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVER_URL: "http://storage-internal:8000",
  },
}));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: vi.fn() }));

describe("Telegram Bot API media adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends shared media and reply references through the provider method", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "image/jpeg" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { message_id: 9, date: 1_800_000_000, chat: { id: 42 } },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(sendTelegramMedia({
      token: "secret-token", chatId: "42", kind: "image",
      media: { url: "https://storage.example/signed", mime: "image/jpeg", caption: "Foto" },
      replyToMessageId: "7",
    })).resolves.toEqual({ messageId: "9", chatId: "42", date: 1_800_000_000 });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://storage.example/signed");
    expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "error" }));
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.telegram.org/botsecret-token/sendPhoto");
    const form = fetch.mock.calls[1]?.[1]?.body as FormData;
    expect(form.get("chat_id")).toBe("42");
    expect(form.get("caption")).toBe("Foto");
    expect(form.get("reply_parameters")).toBe(JSON.stringify({ message_id: 7 }));
    expect(form.get("photo")).toBeInstanceOf(Blob);
  });

  it("baixa a URL assinada do Storage local pelo transporte interno", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, result: { message_id: 9, date: 1_800_000_000, chat: { id: 42 } },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await sendTelegramMedia({
      token: "secret-token", chatId: "42", kind: "document",
      media: { url: "http://127.0.0.1:54321/storage/v1/object/sign/whatsapp-media/test.pdf?token=signed", mime: "application/pdf" },
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://storage-internal:8000/storage/v1/object/sign/whatsapp-media/test.pdf?token=signed",
    );
  });

  it.each([
    "http://127.0.0.1:54321/rest/v1/contacts",
    "http://127.0.0.1:9999/storage/v1/object/sign/x",
    "https://169.254.169.254/latest/meta-data",
    "http://user:pass@127.0.0.1:54321/storage/v1/object/sign/x",
  ])("recusa destinos privados fora do contrato do Storage: %s", async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(sendTelegramMedia({
      token: "secret-token", chatId: "42", kind: "document",
      media: { url, mime: "application/pdf" },
    })).rejects.toThrow("telegram_media_invalid_url");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolve file_id via getFile e baixa apenas pelo host fixo da Bot API", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file.jpg", file_size: 3 } }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200, headers: { "content-type": "image/jpeg", "content-length": "3" },
      }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchTelegramMedia({ token: "secret-token", fileId: "file-123", hintMime: "image/png" }))
      .resolves.toEqual({ buffer: Buffer.from([1, 2, 3]), mime: "image/jpeg" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botsecret-token/getFile");
    expect(String(fetch.mock.calls[1]?.[0])).toBe("https://api.telegram.org/file/botsecret-token/photos/file.jpg");
  });

  it("repete falhas de conexão apenas nas leituras, preservando o prazo total", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { file_path: "documents/file.pdf" } }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError("connection failed"))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchTelegramMedia({ token: "secret-token", fileId: "file-123", hintMime: "application/pdf" }))
      .resolves.toMatchObject({ buffer: Buffer.from([1, 2]), mime: "application/pdf" });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(fetch.mock.calls[1]?.[1]?.signal);
    expect(fetch.mock.calls[2]?.[1]?.signal).toBe(fetch.mock.calls[3]?.[1]?.signal);
  });

  it("sanitizes transport errors so bot tokens never escape through fetch errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockRejectedValueOnce(new TypeError("fetch failed for https://api.telegram.org/botsecret-token/sendPhoto"));
    vi.stubGlobal("fetch", fetch);
    await expect(sendTelegramMedia({
      token: "secret-token", chatId: "42", kind: "image",
      media: { url: "https://storage.example/signed", mime: "image/jpeg" },
    })).rejects.toThrow("telegram_network_error");
    expect(fetch).toHaveBeenCalledTimes(2); // download + exactly one sendPhoto
  });
});

describe("Telegram interactive controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends inline buttons only with bounded opaque callback data", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, result: { message_id: 11, date: 1_800_000_000, chat: { id: -100123 } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await sendTelegramText({
      token: "secret-token", chatId: "-100123", text: "Caso aberto",
      inlineKeyboard: [[{ text: "Abrir caso", callbackData: "case_open_abc123" }]],
    });
    const payload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(payload.reply_markup.inline_keyboard[0][0]).toEqual({
      text: "Abrir caso", callback_data: "case_open_abc123",
    });
  });

  it("recusa callback data arbitrário e confirma callbacks sem expor token", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(sendTelegramText({
      token: "secret-token", chatId: "-100123", text: "Caso",
      inlineKeyboard: [[{ text: "Responder", callbackData: "case:1:resolved:customer text" }]],
    })).rejects.toThrow("telegram_inline_keyboard_invalid");
    await answerTelegramCallbackQuery({
      token: "secret-token", callbackQueryId: "callback_123", text: "Ação recebida",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botsecret-token/answerCallbackQuery");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      callback_query_id: "callback_123", text: "Ação recebida",
    });
  });
});
