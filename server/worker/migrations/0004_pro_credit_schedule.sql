-- Pro includes 1,500 AI credits every 30 days while the plan is active (monthly and yearly alike).
create table pro_credit_schedule (
  user_id text primary key,
  next_grant_at integer not null
);
