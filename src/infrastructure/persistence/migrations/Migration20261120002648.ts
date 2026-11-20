import { Migration } from '@mikro-orm/migrations';

export class Migration20261120002648 extends Migration {

  override name = 'Migration20261120002648';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transaction" ("id" uuid not null, "provider_id" text null, "external_transaction_id" text null, "idempotency_key" text null, "round_id" text null, "game_id" text null, "wallet_id" uuid not null, "player_id" text not null, "kind" text not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "reference_external_transaction_id" text null, "payload_hash" char(64) null, "created_at" timestamptz not null, "status" text not null, "reference_transaction_id" uuid null, "failure_code" text null, "processed_at" timestamptz null, "resolved_at" timestamptz null, "balance_after" numeric(20,2) null, "reference_attempts" int not null, "next_reference_attempt_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "wager_transaction_wallet_id_index" on "wager_transaction" ("wallet_id");`);
    this.addSql(`create index "wager_transaction_pending_reference_index" on "wager_transaction" ("next_reference_attempt_at") where "status" = 'PENDING_REFERENCE';`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_provider_idempotency_key_unique" unique ("provider_id", "idempotency_key");`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_provider_external_id_unique" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`create unique index "wager_transaction_opening_per_wallet_unique" on "wager_transaction" ("wallet_id") where "kind" = 'OPENING';`);
    this.addSql(`create unique index "wager_transaction_single_reversal_unique" on "wager_transaction" ("reference_transaction_id") where "kind" in ('REFUND', 'ROLLBACK') and "status" = 'PROCESSED';`);

    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_wallet_id_foreign" foreign key ("wallet_id") references "wallet" ("id") on update restrict on delete restrict;`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transaction" ("id") on update restrict on delete restrict;`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_status_check" check (status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_kind_check" check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_failure_code_check" check (failure_code in ('INVALID_PAYLOAD', 'INVALID_MONEY', 'INVALID_KIND', 'MISSING_REFERENCE', 'MISSING_IDEMPOTENCY_KEY', 'IDEMPOTENCY_CONFLICT', 'EXTERNAL_TRANSACTION_CONFLICT', 'WALLET_ALREADY_EXISTS', 'WALLET_NOT_FOUND', 'TRANSACTION_NOT_FOUND', 'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'PLAYER_WALLET_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND', 'REFERENCE_NOT_PROCESSED', 'ALREADY_REVERSED', 'AMOUNT_MISMATCH', 'TEMPORARILY_UNAVAILABLE', 'PROCESSING_FAILED'));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_amount_positive_check" check (amount > 0);`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_currency_format_check" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_balance_after_non_negative_check" check (balance_after >= 0);`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_reference_attempts_non_negative_check" check (reference_attempts >= 0);`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_payload_hash_format_check" check (payload_hash ~ '^[0-9a-f]{64}\$');`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_text_length_check" check ((provider_id is null or (char_length(provider_id) >= 1 and char_length(provider_id) <= 255)) and (external_transaction_id is null or (char_length(external_transaction_id) >= 1 and char_length(external_transaction_id) <= 255)) and (idempotency_key is null or (char_length(idempotency_key) >= 1 and char_length(idempotency_key) <= 255)) and (round_id is null or (char_length(round_id) >= 1 and char_length(round_id) <= 255)) and (game_id is null or (char_length(game_id) >= 1 and char_length(game_id) <= 255)) and (player_id is null or (char_length(player_id) >= 1 and char_length(player_id) <= 255)) and (reference_external_transaction_id is null or (char_length(reference_external_transaction_id) >= 1 and char_length(reference_external_transaction_id) <= 255)));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_reference_required_check" check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null);`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_failure_code_status_check" check ((failure_code is not null) = (status in ('REJECTED', 'FAILED')));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_resolved_at_status_check" check ((resolved_at is not null) = (status in ('PROCESSED', 'REJECTED', 'FAILED')));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_processed_at_status_check" check ((processed_at is not null) = (status = 'PROCESSED'));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_reference_transaction_status_check" check (reference_transaction_id is null or status = 'PROCESSED');`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_next_reference_attempt_status_check" check ((next_reference_attempt_at is not null) = (status = 'PENDING_REFERENCE'));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_payload_hash_kind_check" check ((payload_hash is not null) = (kind <> 'OPENING'));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_provider_fields_kind_check" check ((kind = 'OPENING' and provider_id is null and external_transaction_id is null and idempotency_key is null and round_id is null and game_id is null and reference_external_transaction_id is null) or (kind <> 'OPENING' and provider_id is not null and external_transaction_id is not null and idempotency_key is not null and round_id is not null and game_id is not null));`);
    this.addSql(`alter table "wager_transaction" add constraint "wager_transaction_balance_after_status_check" check ((balance_after is not null) = (status = 'PROCESSED' or (status = 'REJECTED' and failure_code <> 'CURRENCY_MISMATCH')));`);
    this.addSql(`create or replace function "wager_transaction_wager_transaction_terminal_immutable_fn"() returns trigger as \$\$ begin IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'wager_transaction rows cannot be deleted'; END IF; IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN RAISE EXCEPTION 'wager_transaction is immutable once terminal'; END IF; RETURN NEW; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "wager_transaction_terminal_immutable" BEFORE UPDATE OR DELETE on "wager_transaction" for each ROW execute function "wager_transaction_wager_transaction_terminal_immutable_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transaction" drop constraint "wager_transaction_reference_transaction_id_foreign";`);

    this.addSql(`drop trigger if exists "wager_transaction_terminal_immutable" on "wager_transaction";`);
    this.addSql(`drop function if exists "wager_transaction_wager_transaction_terminal_immutable_fn"();`);
    this.addSql(`drop table if exists "wager_transaction" cascade;`);
  }

}
