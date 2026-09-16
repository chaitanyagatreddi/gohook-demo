-- Two labels instead of owner/admin: superadmin (Chaitanya, Manvi) and admin (the rest of the team).

alter table public.members drop constraint if exists members_role_check;
update public.members set role = 'superadmin' where role = 'owner';
alter table public.members alter column role set default 'admin';
alter table public.members add constraint members_role_check check (role in ('superadmin', 'admin'));
