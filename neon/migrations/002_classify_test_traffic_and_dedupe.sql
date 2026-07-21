begin;

-- Centraliza a classificação de tráfego para que todos os produtores de eventos
-- (tracker web, Shopify custom pixel e chamadas diretas) sigam as mesmas regras.
create or replace function public.analytics_classify_traffic(
  p_page_url text,
  p_page_path text,
  p_utm_campaign text,
  p_properties jsonb
)
returns table (
  classification text,
  reason text
)
language sql
immutable
parallel safe
as $$
  with normalized as (
    select
      lower(coalesce(p_page_url, '')) as page_url,
      lower(coalesce(p_page_path, '')) as page_path,
      lower(coalesce(p_utm_campaign, '')) as campaign,
      lower(coalesce(p_properties #>> '{server_context,user_agent}', '')) as user_agent,
      lower(coalesce(p_properties ->> 'test', 'false')) = 'true' as is_test,
      lower(coalesce(p_properties ->> 'internal_traffic', 'false')) = 'true' as is_internal
  )
  select
    case
      when is_internal
        or page_url ~ '[?&]ct_internal=(1|true)(&|$)'
        or page_url ~ '^https?://analise-de-dados-fbads[^/]*\.vercel\.app(/|$)'
        or page_url ~ '^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)'
        then 'internal'
      when user_agent ~ '(googlebot|bingbot|duckduckbot|baiduspider|yandexbot|facebookexternalhit|meta-externalagent|meta-externalfetcher|crawler|spider|bot([/ ;]|$))'
        then 'bot'
      when page_url ~ '^https?://gaiety-[^/]+-otavioays-projects\.vercel\.app(/|$)'
        or page_url like '%preview_theme_id=%'
        or page_path like '%preview_theme_id=%'
        or page_url like '%shopify-preview%'
        then 'preview'
      when is_test
        or page_url ~ '[?&]ct_test=(1|true)(&|$)'
        or campaign ~ '(^|[-_ ])(teste|test|qa|debug|internal)([-_ ]|$)'
        then 'qa'
      else 'production'
    end as classification,
    case
      when is_internal then 'property_internal_traffic'
      when page_url ~ '[?&]ct_internal=(1|true)(&|$)' then 'url_ct_internal'
      when page_url ~ '^https?://analise-de-dados-fbads[^/]*\.vercel\.app(/|$)' then 'tracker_control_surface'
      when page_url ~ '^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)' then 'localhost'
      when user_agent ~ '(googlebot|bingbot|duckduckbot|baiduspider|yandexbot|facebookexternalhit|meta-externalagent|meta-externalfetcher|crawler|spider|bot([/ ;]|$))' then 'known_bot_user_agent'
      when page_url ~ '^https?://gaiety-[^/]+-otavioays-projects\.vercel\.app(/|$)' then 'vercel_preview'
      when page_url like '%preview_theme_id=%' or page_path like '%preview_theme_id=%' then 'shopify_theme_preview'
      when page_url like '%shopify-preview%' then 'shopify_preview'
      when is_test then 'property_test'
      when page_url ~ '[?&]ct_test=(1|true)(&|$)' then 'url_ct_test'
      when campaign ~ '(^|[-_ ])(teste|test|qa|debug|internal)([-_ ]|$)' then 'test_campaign'
      else 'production_default'
    end as reason
  from normalized;
$$;

-- Reclassifica o histórico sem apagar eventos. Relatórios existentes já removem
-- properties.test=true e properties.internal_traffic=true.
with classified as (
  select
    e.event_id,
    c.classification,
    c.reason
  from public.analytics_events e
  cross join lateral public.analytics_classify_traffic(
    e.page_url,
    e.page_path,
    e.utm_campaign,
    e.properties
  ) c
)
update public.analytics_events e
set properties =
  coalesce(e.properties, '{}'::jsonb)
  || jsonb_build_object(
    'traffic_classification', c.classification,
    'traffic_classification_reason', c.reason,
    'traffic_classification_version', 1,
    'traffic_classified_at', now()
  )
  || case
       when c.classification <> 'production' then '{"test": true}'::jsonb
       else '{}'::jsonb
     end
  || case
       when c.classification = 'internal' then '{"internal_traffic": true}'::jsonb
       else '{}'::jsonb
     end
from classified c
where e.event_id = c.event_id;

-- Mantém o primeiro evento de cada Shopify event id e marca os demais como
-- duplicatas excluídas. Nada é deletado do histórico bruto.
with ranked_shopify_events as (
  select
    event_id,
    row_number() over (
      partition by nullif(properties ->> 'shopify_event_id', '')
      order by received_at asc, event_id asc
    ) as occurrence
  from public.analytics_events
  where nullif(properties ->> 'shopify_event_id', '') is not null
)
update public.analytics_events e
set properties =
  e.properties
  || jsonb_build_object(
    'traffic_classification', 'duplicate',
    'traffic_classification_reason', 'duplicate_shopify_event_id',
    'traffic_classification_version', 1,
    'traffic_classified_at', now(),
    'test', true
  )
from ranked_shopify_events r
where e.event_id = r.event_id
  and r.occurrence > 1;

-- Índice usado pelo trigger para verificar rapidamente se o Shopify já enviou
-- o mesmo evento. Não é unique porque o histórico bruto é preservado.
create index if not exists analytics_events_shopify_event_id_idx
  on public.analytics_events ((properties ->> 'shopify_event_id'))
  where nullif(properties ->> 'shopify_event_id', '') is not null;

create index if not exists analytics_events_traffic_classification_idx
  on public.analytics_events (
    (properties ->> 'traffic_classification'),
    received_at desc
  );

create or replace function public.analytics_events_before_insert()
returns trigger
language plpgsql
as $$
declare
  v_classification text;
  v_reason text;
  v_shopify_event_id text;
begin
  new.properties := coalesce(new.properties, '{}'::jsonb);
  v_shopify_event_id := nullif(new.properties ->> 'shopify_event_id', '');

  -- Serializa somente eventos com o mesmo identificador Shopify. Isso evita a
  -- corrida em que duas cópias chegam simultaneamente.
  if v_shopify_event_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_shopify_event_id, 0));

    if exists (
      select 1
      from public.analytics_events existing
      where existing.properties ->> 'shopify_event_id' = v_shopify_event_id
      limit 1
    ) then
      return null;
    end if;
  end if;

  select c.classification, c.reason
  into v_classification, v_reason
  from public.analytics_classify_traffic(
    new.page_url,
    new.page_path,
    new.utm_campaign,
    new.properties
  ) c;

  new.properties :=
    new.properties
    || jsonb_build_object(
      'traffic_classification', v_classification,
      'traffic_classification_reason', v_reason,
      'traffic_classification_version', 1,
      'traffic_classified_at', now()
    );

  if v_classification <> 'production' then
    new.properties := new.properties || '{"test": true}'::jsonb;
  end if;

  if v_classification = 'internal' then
    new.properties := new.properties || '{"internal_traffic": true}'::jsonb;
  end if;

  return new;
end;
$$;

drop trigger if exists analytics_events_classify_before_insert
  on public.analytics_events;

create trigger analytics_events_classify_before_insert
before insert on public.analytics_events
for each row
execute function public.analytics_events_before_insert();

comment on function public.analytics_classify_traffic(text, text, text, jsonb) is
  'Classifica eventos como production, internal, qa, preview ou bot.';

comment on function public.analytics_events_before_insert() is
  'Classifica tráfego e descarta duplicatas pelo shopify_event_id antes da gravação.';

commit;
