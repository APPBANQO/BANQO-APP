-- BANQO Perú · actualización v1.4
-- Segura para proyectos que ya ejecutaron schema.sql.
-- No elimina preguntas ni usuarios.

-- Conserva también el objetivo elegido durante el registro.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested_target text;
begin
  requested_target := upper(coalesce(new.raw_user_meta_data ->> 'target_exam', 'RESIDENTADO'));
  if requested_target not in ('RESIDENTADO','ENAM','ESSALUD','TODOS') then
    requested_target := 'RESIDENTADO';
  end if;

  insert into public.profiles (id, full_name, target_exam)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    requested_target
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
