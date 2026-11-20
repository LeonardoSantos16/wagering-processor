import { Migration } from '@mikro-orm/migrations';

export class Migration20261120191354 extends Migration {

  override name = 'Migration20261120191354';

  override up(): void | Promise<void> {
    this.addSql(`drop index "wallet_ledger_entry_wallet_created_at_index";`);
    this.addSql(`create index "wallet_ledger_entry_wallet_created_at_id_index" on "wallet_ledger_entry" ("wallet_id", "created_at", "id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wallet_ledger_entry_wallet_created_at_id_index";`);
    this.addSql(`create index "wallet_ledger_entry_wallet_created_at_index" on "wallet_ledger_entry" ("wallet_id", "created_at");`);
  }

}
