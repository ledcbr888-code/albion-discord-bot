-- Official Events Shadow versus Battle List comparison (Asia, rolling 72 hours).
-- Positive events_lead_ms means the Bot observed this Battle in GameInfo /events
-- before Battleboard first stored it in public.battle_history.
-- This report is diagnostic only; it does not change the discovery source.

with events_first_seen as (
  select
    server,
    battle_id,
    min(observed_at) as events_first_seen_at,
    (array_agg(event_id order by observed_at asc))[1] as representative_event_id,
    bool_or(is_new_battle is true) as events_saw_battle_list_missing,
    min(event_time) as representative_event_time
  from public.discovery_observations
  where source = 'official_events_shadow'
    and server = 'asia'
    and observed_at >= now() - interval '72 hours'
  group by server, battle_id
),
battle_list as (
  select
    server,
    battle_id,
    first_seen_at as battle_list_first_seen_at,
    nullif(coalesce(
      payload ->> 'endTime',
      payload ->> 'EndTime',
      payload ->> 'end_time',
      payload ->> 'battleEndTime',
      payload ->> 'BattleEndTime'
    ), '')::timestamptz as battle_finished_at
  from public.battle_history
  where server = 'asia'
    and first_seen_at >= now() - interval '72 hours'
),
comparison as (
  select
    e.server,
    e.battle_id,
    e.representative_event_id,
    b.battle_finished_at,
    e.events_first_seen_at,
    b.battle_list_first_seen_at,
    case
      when b.battle_list_first_seen_at is not null
      then round(extract(epoch from (b.battle_list_first_seen_at - e.events_first_seen_at)) * 1000)::bigint
      else null
    end as events_lead_ms,
    e.events_saw_battle_list_missing,
    case
      when b.battle_list_first_seen_at is null then 'events-only-or-awaiting-battle-list'
      when b.battle_finished_at is null then 'matched-without-battle-end-time'
      else 'matched'
    end as data_status
  from events_first_seen e
  left join battle_list b
    on b.server = e.server and b.battle_id = e.battle_id
)
select
  battle_id,
  representative_event_id,
  battle_finished_at,
  events_first_seen_at,
  battle_list_first_seen_at,
  events_lead_ms,
  round(events_lead_ms / 60000.0, 2) as events_lead_minutes,
  events_saw_battle_list_missing,
  data_status
from comparison
order by events_first_seen_at desc, battle_id;

-- Summary: use matched Battle IDs only for lead-time decisions.
with events_first_seen as (
  select server, battle_id, min(observed_at) as events_first_seen_at
  from public.discovery_observations
  where source = 'official_events_shadow'
    and server = 'asia'
    and observed_at >= now() - interval '72 hours'
  group by server, battle_id
),
battle_list as (
  select server, battle_id, first_seen_at as battle_list_first_seen_at
  from public.battle_history
  where server = 'asia'
    and first_seen_at >= now() - interval '72 hours'
),
comparison as (
  select
    e.battle_id,
    e.events_first_seen_at,
    b.battle_list_first_seen_at,
    case when b.battle_list_first_seen_at is not null
      then extract(epoch from (b.battle_list_first_seen_at - e.events_first_seen_at)) * 1000
      else null
    end as events_lead_ms
  from events_first_seen e
  left join battle_list b on b.server = e.server and b.battle_id = e.battle_id
)
select
  count(*) as events_battles_observed,
  count(*) filter (where battle_list_first_seen_at is not null) as matched_battles,
  count(*) filter (where battle_list_first_seen_at is null) as events_only_or_pending,
  round(100.0 * count(*) filter (
    where battle_list_first_seen_at is not null
  ) / nullif(count(*), 0), 2) as battle_list_match_rate_pct,
  count(*) filter (where events_lead_ms > 0) as events_found_first,
  round(100.0 * count(*) filter (where events_lead_ms > 0) /
    nullif(count(*) filter (where events_lead_ms is not null), 0), 2) as events_first_share_pct,
  round(avg(events_lead_ms) / 60000.0, 2) as average_signed_lead_minutes,
  round(avg(events_lead_ms) filter (where events_lead_ms > 0) / 60000.0, 2) as average_positive_lead_minutes,
  round((percentile_cont(0.5) within group (order by events_lead_ms))::numeric / 60000.0, 2) as median_lead_minutes
from comparison;

-- Storage/coverage checks. Each row represents only one distinct Battle ID;
-- events without BattleId and extra kills for an already-observed Battle are
-- counted by the application logs but are not stored.
select
  count(*) as stored_battle_observations,
  min(observed_at) as oldest_observation,
  max(observed_at) as newest_observation,
  count(*) filter (where is_new_battle is true) as events_arrived_before_battle_list,
  count(*) filter (where is_new_battle is false) as battle_list_already_seen,
  count(*) filter (where is_new_battle is null) as battle_list_lookup_unknown
from public.discovery_observations
where source = 'official_events_shadow'
  and server = 'asia';
