import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

describe("mcp_artwork_transfers — ACL server-only", () => {
  it("mantém RLS ligada e nenhuma policy cliente", () => {
    expect(sql("select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='mcp_artwork_transfers';")).toBe("t");
    expect(sql("select count(*) from pg_policies where schemaname='public' and tablename='mcp_artwork_transfers';")).toBe("0");
  });

  it.each(["anon", "authenticated"] as const)("%s não pode ler nem alterar tickets", (role) => {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      expect(sql(`select has_table_privilege('${role}', 'public.mcp_artwork_transfers', '${privilege}');`)).toBe("f");
    }
    expect(() => sql(`set role ${role}; select count(*) from public.mcp_artwork_transfers;`)).toThrow();
  });

  it("permite service_role consultar tickets para o consumo autenticado", () => {
    expect(sql("select has_table_privilege('service_role', 'public.mcp_artwork_transfers', 'SELECT');")).toBe("t");
    expect(sql("set role service_role; select count(*) from public.mcp_artwork_transfers;")).toBe("SET\n0");
  });
});
