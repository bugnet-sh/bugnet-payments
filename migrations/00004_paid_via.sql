-- the paying request's Bugnet-Client, null for orders paid before the column existed
alter table orders add column paid_via text check (paid_via in ('checkout', 'pay_cli'));
