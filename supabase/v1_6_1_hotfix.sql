-- BANQO Perú v1.6.1 · hotfix posterior a v1.6
-- Ejecutar UNA VEZ si ya aplicaste supabase/v1_6_audit_fix.sql.
-- No borra preguntas, usuarios, intentos ni progreso.

begin;

-- v1.6.1: subrayados temporales por sesión y permisos de importación.
create or replace function public.reset_session_highlights()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if TG_OP='INSERT' then
    delete from public.user_highlights
    where user_id=new.user_id and question_id=any(new.question_ids);
  elsif old.status is distinct from new.status and new.status='COMPLETADA' then
    delete from public.user_highlights
    where user_id=new.user_id and question_id=any(new.question_ids);
  end if;
  return new;
end; $$;
drop trigger if exists reset_session_highlights_trigger on public.study_sessions;
create trigger reset_session_highlights_trigger
  after insert or update of status on public.study_sessions
  for each row execute function public.reset_session_highlights();

-- Reafirma los privilegios REST necesarios; RLS sigue limitando estas operaciones a admin.
grant select,insert,update,delete on public.import_batches,public.import_items to authenticated;
grant usage,select on sequence public.import_items_id_seq to authenticated;
grant insert,update,delete on public.questions to authenticated;
grant select,insert,update,delete on public.question_versions,public.simulation_sets,public.simulation_questions to authenticated;

drop policy if exists "imports_admin_all" on public.import_batches;
create policy "imports_admin_all" on public.import_batches for all to authenticated
using(public.is_admin()) with check(public.is_admin());
drop policy if exists "import_items_admin_all" on public.import_items;
create policy "import_items_admin_all" on public.import_items for all to authenticated
using(public.is_admin()) with check(public.is_admin());

create or replace function public.admin_import_preflight()
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'allowed',public.is_admin(),
    'role',coalesce((select role from public.profiles where id=auth.uid()),'sin perfil')
  );
$$;
grant execute on function public.admin_import_preflight() to authenticated;

commit;
