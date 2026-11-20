import { Migration } from '@mikro-orm/migrations';

export class Migration20261120001840 extends Migration {

  override name = 'Migration20261120001840';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallet" ("id" uuid not null, "player_id" text not null, "currency" char(3) not null, "balance" numeric(20,2) not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallet" add constraint "wallet_player_currency_unique" unique ("player_id", "currency");`);
    this.addSql(`alter table "wallet" add constraint "wallet_id_currency_unique" unique ("id", "currency");`);

    this.addSql(`alter table "wallet" add constraint "wallet_balance_non_negative_check" check (balance >= 0);`);
    this.addSql(`alter table "wallet" add constraint "wallet_version_positive_check" check (version >= 1);`);
    this.addSql(`alter table "wallet" add constraint "wallet_currency_format_check" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallet" add constraint "wallet_player_id_length_check" check (char_length(player_id) >= 1 and char_length(player_id) <= 255);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallet" cascade;`);
  }

}
