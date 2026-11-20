import { Migration } from '@mikro-orm/migrations';

export class Migration20261120003311 extends Migration {

  override name = 'Migration20261120003311';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallet_ledger_entry" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_entry_wallet_created_at_index" on "wallet_ledger_entry" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_wallet_transaction_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_transaction_id_foreign" foreign key ("transaction_id") references "wager_transaction" ("id") on update restrict on delete restrict;`);
    // Hand-written: MikroORM relations can only target a primary key, and this one targets the
    // wallet (id, currency) unique constraint, so an entry can only be in its wallet currency.
    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_wallet_currency_foreign" foreign key ("wallet_id", "currency") references "wallet" ("id", "currency") on update restrict on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_amount_positive_check" check (amount > 0);`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_balance_before_non_negative_check" check (balance_before >= 0);`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_balance_after_non_negative_check" check (balance_after >= 0);`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_direction_check" check (direction in ('DEBIT', 'CREDIT'));`);
    this.addSql(`alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_balanced_check" check ((direction = 'CREDIT' and balance_after = balance_before + amount) or (direction = 'DEBIT' and balance_after = balance_before - amount));`);
    this.addSql(`create or replace function "wallet_ledger_entry_wallet_ledger_entry_append_only_row_fn"() returns trigger as \$\$ begin RAISE EXCEPTION 'wallet_ledger_entry is append-only'; RETURN NULL; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "wallet_ledger_entry_append_only_row" BEFORE UPDATE OR DELETE on "wallet_ledger_entry" for each ROW execute function "wallet_ledger_entry_wallet_ledger_entry_append_only_row_fn"();`);
    this.addSql(`create or replace function "wallet_ledger_entry_wallet_ledger_entry_append_only_truncate_fn"() returns trigger as \$\$ begin RAISE EXCEPTION 'wallet_ledger_entry is append-only'; RETURN NULL; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "wallet_ledger_entry_append_only_truncate" BEFORE TRUNCATE on "wallet_ledger_entry" for each STATEMENT execute function "wallet_ledger_entry_wallet_ledger_entry_append_only_truncate_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wallet_ledger_entry" drop constraint "wallet_ledger_entry_wallet_currency_foreign";`);
    this.addSql(`drop trigger if exists "wallet_ledger_entry_append_only_row" on "wallet_ledger_entry";`);
    this.addSql(`drop function if exists "wallet_ledger_entry_wallet_ledger_entry_append_only_row_fn"();`);
    this.addSql(`drop trigger if exists "wallet_ledger_entry_append_only_truncate" on "wallet_ledger_entry";`);
    this.addSql(`drop function if exists "wallet_ledger_entry_wallet_ledger_entry_append_only_truncate_fn"();`);
    this.addSql(`drop table if exists "wallet_ledger_entry" cascade;`);
  }

}
