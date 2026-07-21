-- Execute depois da migration 002 para validar a limpeza.

-- 1. Distribuição geral por classificação.
select
  coalesce(properties ->> 'traffic_classification', 'unclassified') as traffic_classification,
  count(*) as events,
  count(distinct visitor_id) as unique_visitors,
  count(distinct session_id) as sessions,
  min(received_at) as first_seen_at,
  max(received_at) as last_seen_at
from public.analytics_events
group by 1
order by events desc;

-- 2. Eventos que continuam válidos para os relatórios de produção.
select
  count(*) as production_events,
  count(distinct visitor_id) as production_unique_visitors,
  count(distinct session_id) as production_sessions,
  count(*) filter (where event_name = 'page_view') as page_views,
  count(*) filter (where event_name = 'checkout_started') as checkout_events,
  count(*) filter (where event_name = 'purchase') as purchase_events
from public.analytics_events
where coalesce(properties ->> 'traffic_classification', 'production') = 'production'
  and coalesce(properties ->> 'test', 'false') <> 'true'
  and coalesce(properties ->> 'internal_traffic', 'false') <> 'true';

-- 3. Confirma que nenhum shopify_event_id é contado mais de uma vez em produção.
select
  properties ->> 'shopify_event_id' as shopify_event_id,
  count(*) as production_copies
from public.analytics_events
where nullif(properties ->> 'shopify_event_id', '') is not null
  and coalesce(properties ->> 'traffic_classification', 'production') = 'production'
group by 1
having count(*) > 1
order by production_copies desc;

-- 4. Motivos de exclusão, útil para detectar regras excessivamente amplas.
select
  coalesce(properties ->> 'traffic_classification_reason', 'unclassified') as reason,
  count(*) as events,
  count(distinct visitor_id) as unique_visitors
from public.analytics_events
where coalesce(properties ->> 'traffic_classification', 'production') <> 'production'
group by 1
order by events desc;

-- 5. Campanhas que ainda aparecem como produção.
select
  coalesce(utm_source, 'direct') as source,
  coalesce(utm_campaign, 'unattributed') as campaign,
  count(*) as events,
  count(distinct visitor_id) as unique_visitors,
  count(*) filter (where event_name = 'checkout_started') as checkout_events,
  count(*) filter (where event_name = 'purchase') as purchase_events
from public.analytics_events
where coalesce(properties ->> 'traffic_classification', 'production') = 'production'
group by 1, 2
order by events desc;
