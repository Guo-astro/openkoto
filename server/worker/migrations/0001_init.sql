-- Better Auth core tables (generated with better-auth 1.7 getMigrations for sqlite)
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");

-- Token layer (docs/specs/auth-spec.md). Timestamps are unix milliseconds.
create table devices (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  platform text not null,
  name text not null,
  app_version text,
  created_at integer not null,
  last_seen_at integer not null,
  revoked_at integer
);
create index devices_user_idx on devices (user_id);

create table refresh_tokens (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  device_id text not null references devices (id) on delete cascade,
  family_id text not null,
  token_hash text not null unique,
  expires_at integer not null,
  created_at integer not null,
  rotated_at integer
);
create index refresh_tokens_family_idx on refresh_tokens (family_id);

create table auth_codes (
  code_hash text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  expires_at integer not null,
  used_at integer
);

create table device_codes (
  device_code_hash text primary key,
  user_code text not null unique,
  client_id text not null,
  device_json text not null,
  status text not null default 'pending',
  user_id text references "user" ("id") on delete cascade,
  poll_interval integer not null default 5,
  last_poll_at integer,
  attempts integer not null default 0,
  expires_at integer not null,
  created_at integer not null
);

create table api_keys (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  scopes text not null,
  created_at integer not null,
  last_used_at integer,
  expires_at integer,
  revoked_at integer
);
create index api_keys_user_idx on api_keys (user_id);

-- Billing
create table subscriptions (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  plan text not null,
  channel text not null,
  external_id text not null,
  status text not null,
  period_end integer not null,
  auto_renew integer not null default 1,
  created_at integer not null,
  updated_at integer not null,
  unique (channel, external_id)
);
create index subscriptions_user_idx on subscriptions (user_id);

create table payment_events (
  channel text not null,
  external_event_id text not null,
  received_at integer not null,
  primary key (channel, external_event_id)
);

create table credit_ledger (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  delta integer not null,
  reason text not null,
  ref_id text,
  balance_after integer not null,
  expires_at integer,
  created_at integer not null
);
create index credit_ledger_user_idx on credit_ledger (user_id, created_at);

create table usage_records (
  request_id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  feature text not null,
  key_id text,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  credits integer not null default 0,
  status text not null,
  created_at integer not null
);
create index usage_records_user_idx on usage_records (user_id, created_at);

-- Activation codes sold offline (e.g. Xiaohongshu); only hashes are stored.
create table activation_codes (
  code_hash text primary key,
  batch text not null,
  plan text,
  duration_days integer not null default 0,
  credits integer not null default 0,
  created_at integer not null,
  redeemed_by text references "user" ("id") on delete set null,
  redeemed_at integer
);

create table jobs (
  id text primary key,
  user_id text not null references "user" ("id") on delete cascade,
  kind text not null,
  status text not null,
  progress integer not null default 0,
  total integer not null default 0,
  params text not null,
  error text,
  created_at integer not null,
  updated_at integer not null
);
create index jobs_user_idx on jobs (user_id, created_at);

create table account_deletions (
  user_id text primary key,
  requested_at integer not null,
  execute_after integer not null
);

create table audit_events (
  id text primary key,
  actor text not null,
  action text not null,
  target text,
  created_at integer not null
);
