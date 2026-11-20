import { Migration } from '@mikro-orm/migrations';

export class Migration20261120155425 extends Migration {

  override name = 'Migration20261120155425';

  override up(): void | Promise<void> {
    this.addSql(`alter table "inbox_message" add constraint "inbox_message_consumer_name_not_empty_check" check (consumer_name <> '');`);
    this.addSql(`alter table "inbox_message" add constraint "inbox_message_message_id_not_empty_check" check (message_id <> '');`);

    this.addSql(`alter table "outbox_message" add constraint "outbox_message_published_without_next_attempt_check" check (published_at is null or next_attempt_at is null);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "inbox_message" drop constraint "inbox_message_consumer_name_not_empty_check";`);
    this.addSql(`alter table "inbox_message" drop constraint "inbox_message_message_id_not_empty_check";`);

    this.addSql(`alter table "outbox_message" drop constraint "outbox_message_published_without_next_attempt_check";`);
  }

}
