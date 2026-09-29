-- Daily CLI/MCP call counter for free accounts (Plus and Pro are unlimited).
create table agent_usage (
  user_id text not null,
  day text not null, -- UTC date, YYYY-MM-DD
  count integer not null default 0,
  primary key (user_id, day)
);
