-- Optional demo data — run AFTER 001_schema.sql if you want to see the panel filled.
-- Safe to skip in production. Delete with the block at the bottom.

update public.settings
set business_name = 'Sharma Finance', owner_name = 'Owner', opening_balance = 200000
where id = 1;

with b as (
  insert into public.borrowers (name, phone, occupation, address)
  values ('Ramesh Kumar', '9876543210', 'Vegetable vendor', 'Main Bazaar'),
         ('Suresh Yadav', '9812345678', 'Auto driver', 'Station Road'),
         ('Meena Devi',   '9898989898', 'Tailor', 'Gali No. 4')
  returning id, name
),
l as (
  insert into public.loans (borrower_id, principal, interest_pct, interest_amount, markup_pct,
                            total_repayable, daily_installment, duration_days,
                            advance_days, advance_amount, loan_date, collection_start_date)
  select id, 10000, 4, 400, 20, 12000, 150, 80, 10, 1500,
         public.today_ist() - 15, public.today_ist() - 14
  from b
  returning id
)
insert into public.loan_disbursements (loan_id, paid_on, amount, note)
select id, public.today_ist() - 15, 4100, 'First part' from l
union all
select id, public.today_ist() - 14, 4000, 'Second part' from l;

-- 12 days of collections for every demo loan
insert into public.loan_repayments (loan_id, paid_on, amount)
select l.id, public.today_ist() - g, 150
from public.loans l, generate_series(2, 13) g;

insert into public.employees (name, phone, designation, monthly_salary, joining_date)
values ('Vikram', '9000000001', 'Collection agent', 12000, public.today_ist() - 200),
       ('Pooja',  '9000000002', 'Accountant',       15000, public.today_ist() - 400);

insert into public.employee_advances (employee_id, given_on, amount, kind)
select id, public.today_ist() - 5, 2000, 'advance' from public.employees where name = 'Vikram';

insert into public.expenses (spent_on, category, amount, description)
values (public.today_ist(),     'Tea / Snacks', 60,  'Office chai'),
       (public.today_ist() - 1, 'Fuel / Petrol', 300, 'Collection round'),
       (public.today_ist() - 3, 'Stationery',    120, 'Register & pens');

-- To remove demo data:
-- delete from public.loans; delete from public.borrowers; delete from public.employees;
-- delete from public.expenses; delete from public.cash_entries;
