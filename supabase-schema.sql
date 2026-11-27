create table if not exists public.material_data (
  material_number text primary key,
  description text not null,
  status text not null,
  is_new boolean not null default false,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null
);

create table if not exists public.material_progress (
  material_number text primary key references public.material_data(material_number) on delete cascade,
  progress jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_metadata (
  id boolean primary key default true check (id),
  generated_at timestamptz not null
);

alter table public.material_data enable row level security;
alter table public.material_progress enable row level security;
alter table public.sync_metadata enable row level security;

revoke all on public.material_data, public.material_progress, public.sync_metadata from anon, authenticated;
grant all on public.material_data, public.material_progress, public.sync_metadata to service_role;

create or replace function public.jsonb_deep_merge(p_base jsonb, p_patch jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  result jsonb := p_base;
  item record;
begin
  if jsonb_typeof(p_base) is distinct from 'object' or jsonb_typeof(p_patch) is distinct from 'object' then
    return p_patch;
  end if;

  for item in select key, value from jsonb_each(p_patch)
  loop
    if result ? item.key then
      result := jsonb_set(result, array[item.key], public.jsonb_deep_merge(result -> item.key, item.value), true);
    else
      result := jsonb_set(result, array[item.key], item.value, true);
    end if;
  end loop;
  return result;
end;
$$;

create or replace function public.merge_material_progress(p_material_number text, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  merged_progress jsonb;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Progress patch must be a JSON object';
  end if;

  insert into public.material_progress(material_number, progress)
  values (p_material_number, p_patch)
  on conflict (material_number) do update
    set progress = public.jsonb_deep_merge(material_progress.progress, excluded.progress),
        updated_at = now()
  returning progress into merged_progress;
  return merged_progress;
end;
$$;

create or replace function public.try_save_material_progress(
  p_material_number text,
  p_patch jsonb,
  p_expected jsonb,
  p_import_only boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved_progress jsonb;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Progress patch must be a JSON object';
  end if;

  if p_import_only or p_expected is null or p_expected = 'null'::jsonb then
    insert into public.material_progress(material_number, progress)
    values (p_material_number, p_patch)
    on conflict (material_number) do nothing
    returning progress into saved_progress;

    if p_import_only and not found then
      select progress into saved_progress
      from public.material_progress
      where material_number = p_material_number;
      return saved_progress;
    end if;
  else
    update public.material_progress
    set progress = public.jsonb_deep_merge(progress, p_patch),
        updated_at = now()
    where material_number = p_material_number and progress = p_expected
    returning progress into saved_progress;
  end if;

  if not found then
    raise exception using errcode = 'PT409', message = 'Material progress changed';
  end if;
  return saved_progress;
end;
$$;

create or replace function public.sync_materials(
  p_materials jsonb,
  p_generated_at timestamptz,
  p_legacy_materials jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  v_material_number text;
begin
  if jsonb_typeof(p_materials) is distinct from 'array' or
     jsonb_typeof(p_legacy_materials) is distinct from 'array' or p_generated_at is null then
    raise exception 'Invalid material snapshot';
  end if;

  -- Serialize snapshots on the metadata row before modifying materials.
  insert into public.sync_metadata(id, generated_at)
  values (true, p_generated_at)
  on conflict (id) do update set generated_at = excluded.generated_at
  where sync_metadata.generated_at <= excluded.generated_at;

  if not found then
    raise exception using errcode = 'PT409', message = 'A newer material snapshot already exists';
  end if;

  for item in select value from jsonb_array_elements(p_legacy_materials)
  loop
    v_material_number := trim(item ->> 'number');
    if v_material_number is null or v_material_number = '' or
       item ->> 'description' is null or item ->> 'status' is null or
       item ->> 'firstSeenAt' is null or item ->> 'lastSeenAt' is null then
      raise exception 'Invalid legacy material';
    end if;

    insert into public.material_data(
      material_number, description, status, is_new, first_seen_at, last_seen_at
    )
    values (
      v_material_number, item ->> 'description', item ->> 'status', false,
      (item ->> 'firstSeenAt')::timestamptz, (item ->> 'lastSeenAt')::timestamptz
    )
    on conflict on constraint material_data_pkey do nothing;
  end loop;

  update public.material_data
  set is_new = false
  where is_new = true;
  for item in select value from jsonb_array_elements(p_materials)
  loop
    v_material_number := trim(item ->> 'number');
    if v_material_number is null or v_material_number = '' or
       item ->> 'description' is null or item ->> 'status' is null then
      raise exception 'Invalid material in snapshot';
    end if;

    insert into public.material_data(
      material_number, description, status, is_new, first_seen_at, last_seen_at
    )
    values (
      v_material_number, item ->> 'description', item ->> 'status', true, p_generated_at, p_generated_at
    )
    on conflict on constraint material_data_pkey do update
      set description = excluded.description,
          status = excluded.status,
          is_new = true,
          last_seen_at = excluded.last_seen_at;
  end loop;
end;
$$;

revoke all on function public.jsonb_deep_merge(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.merge_material_progress(text, jsonb) from public, anon, authenticated;
revoke all on function public.try_save_material_progress(text, jsonb, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.sync_materials(jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.merge_material_progress(text, jsonb) to service_role;
grant execute on function public.try_save_material_progress(text, jsonb, jsonb, boolean) to service_role;
grant execute on function public.sync_materials(jsonb, timestamptz, jsonb) to service_role;
