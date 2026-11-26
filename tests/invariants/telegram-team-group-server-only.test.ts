import { describe, expect, it } from "vitest";
import { motivoDoErro, sql } from "./psql-transporte";

const TABLES = [
  "telegram_bot_bindings",
  "telegram_bot_connections",
  "telegram_bot_surface_capabilities",
  "telegram_case_alert_deliveries",
  "telegram_case_interactions",
  "telegram_case_operators",
  "telegram_case_pairing_challenges",
  "telegram_team_group_members",
  "telegram_team_group_settings",
  "telegram_webhook_updates",
] as const;

function selectComo(role: "anon" | "authenticated", table: string): string | null {
  try {
    sql(`set role ${role}; select * from public.${table} limit 0; reset role;`);
    return null;
  } catch (error) {
    return motivoDoErro(error);
  }
}

describe("Telegram: tabelas internas permanecem exclusivas do servidor", () => {
  it.each(TABLES)("%s tem RLS e não é servida pelo PostgREST", (table) => {
    expect(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`)).toBe("t");
    expect(selectComo("anon", table)).toContain("permission denied");
    expect(selectComo("authenticated", table)).toContain("permission denied");
    expect(sql(`select has_table_privilege('service_role','public.${table}','select')`)).toBe("t");
  });
});

describe("Telegram: IDs de grupo numéricos cabem no registro compartilhado de grupos", () => {
  it("aceita chat_id Telegram e continua aceitando o formato Waha", () => {
    const stamp = Date.now();
    const org = `9a000000-0000-4000-8000-${String(stamp).slice(-12)}`;
    const session = `9c000000-0000-4000-8000-${String(stamp).slice(-12)}`;
    const connection = `9d000000-0000-4000-8000-${String(stamp).slice(-12)}`;
    const group1 = `9e000000-0000-4000-8000-${String(stamp).slice(-12)}`;
    const group2 = `9f000000-0000-4000-8000-${String(stamp).slice(-12)}`;
    sql(`
      insert into public.organizations(id,slug,legal_name,display_name)
        values ('${org}','tg-group-${stamp}','Telegram group test','Telegram group test');
      insert into public.telegram_bot_connections(id,organization_id,telegram_bot_id,display_name,token_encrypted,token_last4,status)
        values ('${connection}','${org}','${stamp}','Telegram test',decode('00','hex'),'1234','active');
      insert into public.channel_sessions(id,organization_id,provider,telegram_bot_connection_id,waha_session_name,phone_number,display_name,webhook_secret_encrypted,status)
        values ('${session}','${org}','telegram','${connection}',null,null,'Telegram test',decode('00','hex'),'WORKING');
      insert into public.channel_session_groups(id,organization_id,channel_session_id,group_chat_id,subject)
        values ('${group1}','${org}','${session}','-1001234567890','Telegram QA');
      insert into public.channel_session_groups(id,organization_id,channel_session_id,group_chat_id,subject)
        values ('${group2}','${org}','${session}','12025550123@g.us','Waha QA');
    `);
    expect(sql(`select count(*) from public.channel_session_groups where id in ('${group1}','${group2}')`)).toBe("2");
  });
});
