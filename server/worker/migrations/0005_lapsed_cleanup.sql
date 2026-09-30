-- Lapsed memberships: reminder at 60 days, removal of book files above the free storage at 90.
create table lapsed_cleanup (
  user_id text primary key,
  lapsed_at integer not null,   -- end of the last paid period this row refers to
  reminded_at integer,
  purged_at integer,
  purged_bytes integer not null default 0
);
