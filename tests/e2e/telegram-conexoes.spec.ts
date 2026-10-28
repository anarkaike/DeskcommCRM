/** A aba Telegram precisa ser alcançável pela URL e visível no frontend autenticado. */
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "./helpers/test";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ timeout: 180_000 });

test("Conexões abre a aba Telegram e mostra o cadastro de bots", async ({ page }) => {
  await loginComoAdmin(page, lerCreds());
  await page.goto("/app/connections?aba=telegram");

  const aba = page.getByRole("tab", { name: "Telegram" });
  await expect(aba).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("telegram-connections")).toBeVisible();
  await expect(page.getByLabel("Nome para identificar o bot")).toBeVisible();
  await expect(page.getByLabel("Token do bot")).toBeVisible();

  const evidencia = path.join(process.cwd(), "evidence", "telegram", "conexoes-aba.png");
  fs.mkdirSync(path.dirname(evidencia), { recursive: true });
  await page.screenshot({ path: evidencia, fullPage: true });
});
