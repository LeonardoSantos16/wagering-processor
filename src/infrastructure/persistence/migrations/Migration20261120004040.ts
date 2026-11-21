import { Migration } from '@mikro-orm/migrations';

export class Migration20261120004040 extends Migration {

  override name = 'Migration20261120004040';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_message" ("consumer_name" text not null, "message_id" text not null, "payload_hash" char(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("consumer_name", "message_id"));`);

    this.addSql(`create table "outbox_message" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" text not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_message_pending_index" on "outbox_message" ("next_attempt_at") where "published_at" is null;`);

    this.addSql(`alter table "inbox_message" add constraint "inbox_message_payload_hash_format_check" check (payload_hash ~ '^[0-9a-f]{64}\$');`);

    this.addSql(`alter table "outbox_message" add constraint "outbox_message_attempts_non_negative_check" check (attempts >= 0);`);
    this.addSql(`alter table "outbox_message" add constraint "outbox_message_event_type_not_empty_check" check (event_type <> '');`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_message" cascade;`);
    this.addSql(`drop table if exists "outbox_message" cascade;`);
  }

}
