// @vitest-environment node
import { describe, expect, it } from "vitest";

import { definirFerramentasRemotas } from "@/lib/mcp/tools/externo";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";

const SOMENTE_LEITURA = [
  "servinder_woocommerce_products_search",
  "servinder_woocommerce_products_get",
  "servinder_woocommerce_product_schema_get",
  "servinder_woocommerce_customers_search",
  "servinder_woocommerce_customers_get",
  "servinder_woocommerce_quote_get",
  "servinder_woocommerce_orders_search",
  "servinder_woocommerce_orders_get",
  "servinder_woocommerce_order_items_list",
  "servinder_woocommerce_artwork_get",
] as const;

const TODAS_AS_TOOLS = [
  ...SOMENTE_LEITURA,
  "servinder_woocommerce_product_schema_update",
  "servinder_woocommerce_customers_create",
  "servinder_woocommerce_customers_update",
  "servinder_woocommerce_quote_create",
  "servinder_woocommerce_quote_recalculate",
  "servinder_woocommerce_orders_create",
  "servinder_woocommerce_orders_update",
  "servinder_woocommerce_orders_archive",
  "servinder_woocommerce_orders_restore",
  "servinder_woocommerce_order_items_add",
  "servinder_woocommerce_order_items_update",
  "servinder_woocommerce_order_items_remove",
  "servinder_woocommerce_artwork_import",
  "servinder_woocommerce_order_item_artwork_attach",
] as const;

const EXCLUIDAS_DO_AGENTE_DE_VENDAS = new Set([
  "servinder_woocommerce_product_schema_update",
  "servinder_woocommerce_artwork_import",
  "servinder_woocommerce_artwork_get",
  "servinder_woocommerce_order_item_artwork_attach",
]);
const FERRAMENTAS_DE_VENDA = TODAS_AS_TOOLS.filter((name) => !EXCLUIDAS_DO_AGENTE_DE_VENDAS.has(name));
const LEITURA = new Set<string>(SOMENTE_LEITURA);
const ferramentas: FerramentaRemota[] = TODAS_AS_TOOLS.map((name) => ({
  name,
  description: `Descrição de ${name}`,
  somenteLeitura: LEITURA.has(name),
  inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
}));
const servidor = { endpoint: "https://diskuniformes.servinder.com.br/wp-json/servinder/v1/mcp", chave: "token-de-teste" };

describe("contrato do CRM ↔ Servinder WooCommerce MCP", () => {
  it("preserva os nomes e classifica as 24 tools anunciadas no escopo correto", () => {
    const escolhas = TODAS_AS_TOOLS.map((nome) => ({ nome, leitura: LEITURA.has(nome) }));
    const montadas = definirFerramentasRemotas(servidor, ferramentas, new Set(), escolhas);

    expect(montadas).toHaveLength(24);
    expect(montadas.map(({ name }) => name)).toEqual(TODAS_AS_TOOLS);
    for (const tool of montadas) {
      const leitura = LEITURA.has(tool.name);
      expect(tool.category).toBe(leitura ? "read" : "write");
      expect(tool.requiresScope).toBe(leitura ? "mcp:read" : "mcp:write");
      expect(tool.requiresRole).toBe("agent");
    }
  });

  it("permite selecionar o catálogo inteiro sem entregar schema e arte ao agente de vendas", () => {
    const escolhas = FERRAMENTAS_DE_VENDA.map((nome) => ({ nome, leitura: LEITURA.has(nome) }));
    const montadas = definirFerramentasRemotas(servidor, ferramentas, new Set(), escolhas);

    expect(FERRAMENTAS_DE_VENDA).toHaveLength(20);
    expect(montadas.map(({ name }) => name)).toEqual(FERRAMENTAS_DE_VENDA);
    expect(montadas.some(({ name }) => EXCLUIDAS_DO_AGENTE_DE_VENDAS.has(name))).toBe(false);
  });

  it("não confia apenas no readOnlyHint remoto para liberar uma escrita", () => {
    const name = "servinder_woocommerce_orders_archive";
    const [montada] = definirFerramentasRemotas(
      servidor,
      [{ name, somenteLeitura: true }],
      new Set(),
      [{ nome: name, leitura: false }],
    );

    expect(montada?.name).toBe(name);
    expect(montada?.category).toBe("write");
    expect(montada?.requiresScope).toBe("mcp:write");
  });
});
