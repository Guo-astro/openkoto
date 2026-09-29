-- OAuth 2.1 dynamic client registration for remote MCP clients (Claude web/desktop, …).
-- Authorization codes reuse auth_codes (client_id = oauth_clients.client_id); tokens are
-- ordinary device tokens (devices.platform = 'mcp') with the reduced MCP scope set.
create table oauth_clients (
  client_id text primary key,
  client_name text not null,
  redirect_uris text not null,
  created_at integer not null
);
