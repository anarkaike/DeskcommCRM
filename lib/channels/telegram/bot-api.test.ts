import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTelegramMedia, sendTelegramMedia } from "./bot-api";

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

  it("sanitizes transport errors so bot tokens never escape through fetch errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
      .mockRejectedValueOnce(new TypeError("fetch failed for https://api.telegram.org/botsecret-token/sendPhoto"));
    vi.stubGlobal("fetch", fetch);
    await expect(sendTelegramMedia({
      token: "secret-token", chatId: "42", kind: "image",
      media: { url: "https://storage.example/signed", mime: "image/jpeg" },
    })).rejects.toThrow("telegram_network_error");
  });
});
